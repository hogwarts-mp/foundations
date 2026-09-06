import type { HmpWebhookMessage } from "../types";
import type { RouteOptions, WebhookRouteConfig } from "./internal";

interface Participant {
    playerId?: unknown;
    nickname?: unknown;
    character?: unknown;
    characterName?: unknown;
}

const text = (value: unknown, fallback = "—"): string => {
    const output = String(value ?? "").trim();
    return output || fallback;
};

function safeJson(value: unknown, maximum = 1000): string {
    try {
        const encoded = JSON.stringify(value);
        return encoded ? Array.from(encoded).slice(0, maximum).join("") : "—";
    } catch (_) {
        return "—";
    }
}

function nameList(value: unknown): string {
    if (!Array.isArray(value) || !value.length) return "—";
    return value.map((raw) => {
        const participant = raw && typeof raw === "object" ? raw as Participant : {};
        const character = text(participant.characterName ?? participant.character, "");
        const nickname = text(participant.nickname, "");
        const fallback = participant.playerId === undefined ? "unknown" : `#${participant.playerId}`;
        const primary = character || nickname || fallback;
        return character && nickname && character !== nickname ? `${character} (${nickname})` : primary;
    }).join(", ");
}

function allowed(config: WebhookRouteConfig, value: unknown, caseInsensitive = false): boolean {
    if (!config.only.length) return true;
    const candidate = String(value ?? "");
    return caseInsensitive
        ? config.only.some((entry) => entry.toLowerCase() === candidate.toLowerCase())
        : config.only.includes(candidate);
}

function registerRoutes(options: RouteOptions): void {
    const { events, routes, send } = options;

    if (routes.gauntlet.enabled) events.on("hmp-gauntlet:complete", (raw: unknown) => {
        if (!raw || typeof raw !== "object") return;
        const payload = raw as Record<string, unknown>;
        if (payload.cancelled) return;
        const won = payload.won === true;
        const waves = payload.endless ? text(payload.wave) : `${text(payload.wave, "0")}/${text(payload.waves, "0")}`;
        send(routes.gauntlet.destination, {
            title: won ? "🏆 Gauntlet cleared" : "💀 Gauntlet over",
            color: won ? 0x3ba55d : 0xed4245,
            fields: [
                { name: "Waves", value: waves, inline: true },
                { name: "Score", value: text(payload.score, "0"), inline: true },
                { name: "Preset", value: text(payload.preset, "?"), inline: true },
                { name: "Fighters", value: nameList(payload.participants) },
            ],
            timestamp: text(payload.finishedAt, new Date().toISOString()),
        });
    });

    if (routes.activities.enabled) events.on("hmp:activities:completed", (raw: unknown) => {
        if (!raw || typeof raw !== "object") return;
        const payload = raw as Record<string, unknown>;
        const session = payload.session && typeof payload.session === "object" ? payload.session as Record<string, unknown> : null;
        const activityId = session?.activityId;
        if (!session || !allowed(routes.activities, activityId)) return;
        const message: HmpWebhookMessage = {
            title: `⚔ ${text(activityId, "Activity")} finished`,
            color: 0x5865f2,
            fields: [
                { name: "Result", value: safeJson(payload.result) },
                { name: "Reason", value: text(payload.reason), inline: true },
                { name: "Participants", value: nameList(session.participants) },
            ],
            timestamp: text(session.endedAt, new Date().toISOString()),
        };
        send(routes.activities.destination, message);
    });

    if (routes.spells.enabled) events.on("hmp:spells:cast", (raw: unknown) => {
        if (!raw || typeof raw !== "object") return;
        const payload = raw as Record<string, unknown>;
        if (!allowed(routes.spells, payload.name, true)) return;
        const player = payload.player && typeof payload.player === "object" ? payload.player as Record<string, unknown> : null;
        const character = payload.character && typeof payload.character === "object" ? payload.character as Record<string, unknown> : null;
        const who = text(character?.name ?? player?.nickname, "someone");
        const name = text(payload.name, "Unknown spell");
        send(routes.spells.destination, {
            title: `✨ ${name}`,
            description: `${who} reportedly cast **${name}**${payload.entitled ? "" : " _(not entitled)_"}`,
            color: 0x9b59b6,
            footer: payload.advisory === false ? "Server event" : "Client-reported advisory event",
            timestamp: text(payload.receivedAt, new Date().toISOString()),
        });
    });
}

export = { registerRoutes, nameList, safeJson };
