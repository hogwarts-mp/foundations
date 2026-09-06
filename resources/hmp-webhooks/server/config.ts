import type { HmpLibServer } from "../../hmp-lib/types";
import type { WebhookDestinationConfig, WebhookRouteConfig, WebhooksConfig } from "./internal";

type RawDestination = Partial<Omit<WebhookDestinationConfig, "id">> & Record<string, unknown>;
type RawRoute = Partial<WebhookRouteConfig> & Record<string, unknown>;
interface RawConfig extends Record<string, unknown> {
    enabled: boolean;
    destinations: Record<string, RawDestination>;
    routes: { gauntlet: RawRoute; activities: RawRoute; spells: RawRoute };
}

const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
    const parsed = Math.trunc(Number(value));
    return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
};

const stringList = (value: unknown): string[] => Array.isArray(value)
    ? [...new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean))]
    : [];

function normalizeRoute(raw: RawRoute | undefined, fallback: WebhookRouteConfig): WebhookRouteConfig {
    return {
        enabled: raw?.enabled === undefined ? fallback.enabled : raw.enabled === true,
        destination: String(raw?.destination || fallback.destination).trim().toLowerCase(),
        only: raw?.only === undefined ? [...fallback.only] : stringList(raw.only),
    };
}

function loadConfig(
    Hmp: HmpLibServer,
    options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): WebhooksConfig {
    const env = options.env || process.env;
    const defaultDestination: RawDestination = {
        enabled: true,
        provider: "discord",
        url: "",
        urlEnv: "HMP_WEBHOOKS_DISCORD_URL",
        username: "Hogwarts MP",
        avatarUrl: "",
        minIntervalMs: 1500,
        queueLimit: 40,
        maxAttempts: 4,
        retryBaseMs: 1000,
        requestTimeoutMs: 10000,
    };
    const defaults: RawConfig = {
        enabled: false,
        destinations: { discord: defaultDestination },
        routes: {
            gauntlet: { enabled: true, destination: "discord", only: [] },
            activities: { enabled: true, destination: "discord", only: ["duel:standard"] },
            spells: { enabled: true, destination: "discord", only: ["AvadaKedavra", "Crucio", "Imperio"] },
        },
    };
    const loaded = Hmp.config.load<RawConfig>(env.HMP_WEBHOOKS_CONFIG || "data/hmp-webhooks.json", {
        cwd: options.cwd || process.cwd(),
        defaults,
    });
    const enabled = env.HMP_WEBHOOKS_ENABLED === undefined
        ? loaded.enabled === true
        : Hmp.config.env.boolean(env.HMP_WEBHOOKS_ENABLED, false);
    if (!loaded.destinations || typeof loaded.destinations !== "object" || Array.isArray(loaded.destinations)) {
        throw new TypeError("hmp-webhooks destinations must be an object");
    }

    const destinations: Record<string, WebhookDestinationConfig> = {};
    for (const [rawId, rawValue] of Object.entries(loaded.destinations)) {
        const id = String(rawId).trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9_.:-]{0,63}$/.test(id)) throw new TypeError(`invalid webhook destination '${rawId}'`);
        if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) throw new TypeError(`webhook destination '${id}' must be an object`);
        // New destinations must name their own secret. Only the built-in `discord` entry inherits
        // HMP_WEBHOOKS_DISCORD_URL through the fully merged default config.
        const raw = { ...defaultDestination, urlEnv: "", ...rawValue };
        const urlEnv = String(raw.urlEnv || "").trim();
        const url = String((urlEnv && env[urlEnv]) || raw.url || "").trim();
        destinations[id] = {
            id,
            enabled: raw.enabled !== false,
            provider: String(raw.provider || "discord").trim().toLowerCase(),
            url,
            urlEnv,
            username: String(raw.username || "Hogwarts MP").trim().slice(0, 80),
            avatarUrl: String(raw.avatarUrl || "").trim(),
            minIntervalMs: boundedInteger(raw.minIntervalMs, 1500, 0, 60000),
            queueLimit: boundedInteger(raw.queueLimit, 40, 1, 10000),
            maxAttempts: boundedInteger(raw.maxAttempts, 4, 1, 10),
            retryBaseMs: boundedInteger(raw.retryBaseMs, 1000, 100, 60000),
            requestTimeoutMs: boundedInteger(raw.requestTimeoutMs, 10000, 1000, 60000),
        };
    }

    const rawRoutes = loaded.routes || defaults.routes;
    return {
        enabled,
        destinations,
        routes: {
            gauntlet: normalizeRoute(rawRoutes.gauntlet, defaults.routes.gauntlet as WebhookRouteConfig),
            activities: normalizeRoute(rawRoutes.activities, defaults.routes.activities as WebhookRouteConfig),
            spells: normalizeRoute(rawRoutes.spells, defaults.routes.spells as WebhookRouteConfig),
        },
    };
}

export = { loadConfig };
