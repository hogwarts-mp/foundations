import type { HmpPvpClient } from "../types";

// The host resolves who may hurt whom for this client; it only records the server's lethal-mode flag.
let lethal = false;

function apply(raw: unknown): void {
    let payload: Record<string, unknown> = {};
    if (typeof raw === "string") {
        try {
            payload = JSON.parse(raw) as Record<string, unknown>;
        } catch (_) {
            payload = {};
        }
    } else if (raw && typeof raw === "object") {
        payload = raw as Record<string, unknown>;
    }
    lethal = payload.enabled === true;
}

const client: HmpPvpClient = Object.freeze({
    mode: Object.freeze({
        isLethal: () => lethal,
    }),
});

Exports.register("mode", client.mode);
Events.on("hmp-pvp:mode", apply);
Events.on("resourceStop", (name?: string) => {
    if (!name || name === "hmp-pvp") lethal = false;
});
