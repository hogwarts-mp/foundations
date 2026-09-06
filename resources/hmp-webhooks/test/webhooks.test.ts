import assert = require("node:assert");
import configModule = require("../server/config");
import discordModule = require("../server/providers/discord");
import routesModule = require("../server/routes");
import serviceModule = require("../server/service");
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpWebhookMessage } from "../types";
import type { Logger, WebhookDestinationConfig, WebhooksConfig } from "../server/internal";

const { loadConfig } = configModule;
const { createDiscordProvider } = discordModule;
const { registerRoutes } = routesModule;
const { createWebhookService } = serviceModule;

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const routes = {
    gauntlet: { enabled: true, destination: "discord", only: [] },
    activities: { enabled: true, destination: "discord", only: ["duel:standard"] },
    spells: { enabled: true, destination: "discord", only: ["Crucio"] },
};

function destination(overrides: Partial<WebhookDestinationConfig> = {}): WebhookDestinationConfig {
    return {
        id: "discord", enabled: true, provider: "discord",
        url: "https://discord.com/api/webhooks/123/token", urlEnv: "HMP_WEBHOOKS_DISCORD_URL",
        username: "Hogwarts MP", avatarUrl: "", minIntervalMs: 0, queueLimit: 10,
        maxAttempts: 3, retryBaseMs: 100, requestTimeoutMs: 5000,
        ...overrides,
    };
}

function serviceConfig(overrides: Partial<WebhookDestinationConfig> = {}): WebhooksConfig {
    const configured = destination(overrides);
    return { enabled: true, destinations: { [configured.id]: configured }, routes };
}

async function run(): Promise<void> {
    const provider = createDiscordProvider();
    assert.strictEqual(provider.validate(destination()), null);
    assert.match(provider.validate(destination({ url: "http://discord.com/api/webhooks/1/token" })) || "", /HTTPS/);
    assert.match(provider.validate(destination({ url: "https://example.com/hook" })) || "", /Discord/);
    const formatted = provider.request(destination(), {
        content: "hello",
        title: "A".repeat(300),
        description: "world",
        fields: [{ name: "Score", value: "42", inline: true }],
        color: 0x123456,
    });
    const discordBody = JSON.parse(formatted.body);
    assert.strictEqual(Array.from(discordBody.embeds[0].title).length, 256);
    assert.deepStrictEqual(discordBody.allowed_mentions, { parse: [] });
    assert.strictEqual(discordBody.embeds[0].fields[0].inline, true);

    const posted: Array<{ url: string; body: HmpWebhookMessage }> = [];
    const service = createWebhookService({
        config: serviceConfig(), logger, providers: [provider], sleep: async () => undefined,
        fetch: (async (url, init) => {
            posted.push({ url: String(url), body: JSON.parse(String(init?.body)) });
            return new Response(null, { status: 204 });
        }) as typeof fetch,
    });
    assert.strictEqual(service.send("discord", { title: "Duel complete", description: "Smoke won" }), true);
    assert.strictEqual(service.send("missing", { content: "ignored" }), false);
    assert.strictEqual(service.send("discord", {}), false);
    await service.idle();
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(service.status().destinations[0].delivered, 1);
    assert.strictEqual(service.status().destinations[0].lastStatus, 204);

    const cooldowns: number[] = [];
    const paced = createWebhookService({
        config: serviceConfig({ minIntervalMs: 25 }), logger, providers: [provider],
        sleep: async (milliseconds) => { cooldowns.push(milliseconds); },
        fetch: (async () => new Response(null, { status: 204 })) as typeof fetch,
    });
    paced.send("discord", { content: "paced" });
    await paced.idle();
    assert.deepStrictEqual(cooldowns, [25]);

    const delays: number[] = [];
    let attempts = 0;
    const retrying = createWebhookService({
        config: serviceConfig(), logger, providers: [provider], sleep: async (milliseconds) => { delays.push(milliseconds); },
        fetch: (async () => {
            attempts++;
            return attempts === 1
                ? new Response(JSON.stringify({ retry_after: 0.25 }), { status: 429, headers: { "retry-after": "0.25" } })
                : new Response(null, { status: 204 });
        }) as typeof fetch,
    });
    assert.strictEqual(retrying.send("discord", { content: "retry me" }), true);
    await retrying.idle();
    assert.strictEqual(attempts, 2);
    assert.deepStrictEqual(delays, [250]);
    assert.strictEqual(retrying.status().destinations[0].delivered, 1);

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const deliveredTitles: string[] = [];
    let requestCount = 0;
    const bounded = createWebhookService({
        config: serviceConfig({ queueLimit: 2 }), logger, providers: [provider], sleep: async () => undefined,
        fetch: (async (_url, init) => {
            const body = JSON.parse(String(init?.body));
            deliveredTitles.push(body.embeds[0].title);
            requestCount++;
            if (requestCount === 1) await firstGate;
            return new Response(null, { status: 204 });
        }) as typeof fetch,
    });
    bounded.send("discord", { title: "first" });
    bounded.send("discord", { title: "oldest pending" });
    bounded.send("discord", { title: "third" });
    bounded.send("discord", { title: "newest" });
    releaseFirst();
    await bounded.idle();
    assert.deepStrictEqual(deliveredTitles, ["first", "third", "newest"]);
    assert.strictEqual(bounded.status().destinations[0].accepted, 4);
    assert.strictEqual(bounded.status().destinations[0].dropped, 1);

    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const routed: Array<{ destination: string; message: HmpWebhookMessage }> = [];
    registerRoutes({
        events: { on: (name, handler) => handlers.set(name, handler) }, routes,
        send: (target, message) => { routed.push({ destination: target, message }); return true; },
    });
    handlers.get("hmp:activities:completed")?.({
        session: {
            activityId: "duel:standard", endedAt: "2026-09-05T12:00:00.000Z",
            participants: [{ playerId: 1, nickname: "Smoke", characterName: "Harry" }],
        },
        reason: "ko", result: { winnerId: 1 },
    });
    handlers.get("hmp:activities:completed")?.({ session: { activityId: "not-selected" } });
    handlers.get("hmp:spells:cast")?.({
        name: "crucio", player: { nickname: "Smoke" }, character: { name: "Harry" },
        entitled: false, advisory: true, receivedAt: "2026-09-05T12:00:00.000Z",
    });
    handlers.get("hmp-gauntlet:complete")?.({
        won: true, cancelled: false, wave: 5, waves: 5, score: 100,
        participants: [{ playerId: 1, nickname: "Smoke", character: "Harry" }],
    });
    assert.strictEqual(routed.length, 3);
    assert.match(routed[0].message.fields?.[2].value || "", /Harry \(Smoke\)/);
    assert.match(routed[1].message.footer || "", /advisory/);
    assert.strictEqual(routed[2].message.title, "🏆 Gauntlet cleared");

    const fakeHmp = {
        config: {
            load: (_path: string, options: { defaults: Record<string, unknown> }) => ({ ...options.defaults, enabled: true }),
            env: { boolean: (value: unknown, fallback: boolean) => value === undefined ? fallback : String(value) === "true" },
        },
    } as unknown as HmpLibServer;
    const loaded = loadConfig(fakeHmp, { env: { HMP_WEBHOOKS_DISCORD_URL: destination().url } });
    assert.strictEqual(loaded.enabled, true);
    assert.strictEqual(loaded.destinations.discord.url, destination().url);

    assert.strictEqual(service.stop(), 0);
    assert.strictEqual(service.status().state, "stopped");
    assert.strictEqual(service.send("discord", { content: "after stop" }), false);
    console.log("hmp-webhooks tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
