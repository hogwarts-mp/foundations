import type { HmpWebhookField, HmpWebhookMessage } from "../../types";
import type { ProviderRequest, WebhookDestinationConfig, WebhookProvider } from "../internal";

const DISCORD_HOST = /^(?:canary\.|ptb\.)?discord(?:app)?\.com$/i;

function truncate(value: unknown, maximum: number): string {
    const characters = Array.from(String(value ?? ""));
    return characters.length <= maximum ? characters.join("") : characters.slice(0, maximum).join("");
}

function discordEmbed(message: HmpWebhookMessage): Record<string, unknown> | null {
    const hasEmbed = Boolean(message.title || message.description || message.footer || message.fields?.length);
    if (!hasEmbed) return null;
    let remaining = 6000;
    const take = (value: unknown, maximum: number): string => {
        const output = truncate(value, Math.max(0, Math.min(maximum, remaining)));
        remaining -= Array.from(output).length;
        return output;
    };
    const title = take(message.title, 256);
    const description = take(message.description, 4096);
    const fields: Array<{ name: string; value: string; inline: boolean }> = [];
    for (const field of message.fields || []) {
        if (fields.length >= 25 || remaining < 2) break;
        const name = take(field?.name, 256);
        const value = take(field?.value, 1024);
        if (name && value) fields.push({ name, value, inline: field.inline === true });
    }
    const footer = take(message.footer, 2048);
    const timestampValue = message.timestamp ? new Date(message.timestamp) : null;
    const timestamp = timestampValue && Number.isFinite(timestampValue.getTime()) ? timestampValue.toISOString() : undefined;
    const color = Number.isFinite(Number(message.color))
        ? Math.max(0, Math.min(0xffffff, Math.trunc(Number(message.color))))
        : undefined;
    return {
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        ...(fields.length ? { fields } : {}),
        ...(footer ? { footer: { text: footer } } : {}),
        ...(timestamp ? { timestamp } : {}),
        ...(color === undefined ? {} : { color }),
    };
}

function validate(destination: WebhookDestinationConfig): string | null {
    if (!destination.url) return "URL is not configured";
    let parsed: URL;
    try { parsed = new URL(destination.url); }
    catch (_) { return "URL is invalid"; }
    if (parsed.protocol !== "https:") return "URL must use HTTPS";
    if (!DISCORD_HOST.test(parsed.hostname) || !/^\/api(?:\/v\d+)?\/webhooks\/[^/]+\/[^/]+/.test(parsed.pathname)) {
        return "URL is not a Discord webhook endpoint";
    }
    return null;
}

function request(destination: WebhookDestinationConfig, message: HmpWebhookMessage): ProviderRequest {
    const embed = discordEmbed(message);
    const content = truncate(message.content, 2000);
    const username = truncate(message.username || destination.username, 80);
    const avatarUrl = String(message.avatarUrl || destination.avatarUrl || "").trim();
    const body = {
        ...(content ? { content } : {}),
        ...(username ? { username } : {}),
        ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
        ...(embed ? { embeds: [embed] } : {}),
        allowed_mentions: { parse: [] },
    };
    return { headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function retryAfter(response: Response): Promise<number | null> {
    const rawHeader = response.headers.get("retry-after") || response.headers.get("x-ratelimit-reset-after");
    if (rawHeader) {
        const seconds = Number(rawHeader);
        if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
        const date = Date.parse(rawHeader);
        if (Number.isFinite(date)) return Math.max(0, date - Date.now());
    }
    try {
        const body = await response.json() as { retry_after?: unknown };
        const seconds = Number(body?.retry_after);
        return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
    } catch (_) {
        return null;
    }
}

function createDiscordProvider(): WebhookProvider {
    return Object.freeze({ name: "discord", validate, request, retryAfter });
}

export = { createDiscordProvider, discordEmbed };
