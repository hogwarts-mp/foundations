import serviceModule = require("./service");
import type { HmpInteractPlayer } from "../types";

const { createInteractService } = serviceModule;
const Hmp = Imports.get("hmp-lib");
const core = Imports.get("hmp-core");
const inventory = Imports.get("hmp-inventory");
const ui = Imports.get("hmp-ui");
const logger = Hmp.logger.create("hmp-interact");
const interact = createInteractService<HmpInteractPlayer>({
    core,
    inventory,
    ui,
    players: () => PlayerManager.getAll(),
    events: Events,
    worldObjects: typeof WorldObject === "undefined" ? undefined : WorldObject,
    characters: typeof Character === "undefined" ? undefined : Character,
    logger,
});

for (const name of ["register", "unregister", "get", "list", "trigger", "sync", "status"] as const) Exports.register(name, interact[name]);

function payloadId(raw: unknown): string {
    const payload = typeof raw === "string" ? (() => { try { return JSON.parse(raw) as Record<string, unknown>; } catch (_) { return {}; } })() : raw as Record<string, unknown>;
    return String(payload?.id || "");
}

Events.onClient("hmp-interact:ready", (player) => interact.sync(player));
Events.onClient("hmp-interact:trigger", (player, raw: unknown) => {
    interact.trigger(player, payloadId(raw)).catch((error) => logger.error("interaction trigger failed", error));
});
Events.onClient("hmp-interact:stand", (player, raw: unknown) => interact.stand(player, payloadId(raw)));
Events.on("playerConnect", (player: HmpInteractPlayer) => interact.sync(player));
Events.on("playerDisconnect", (player: HmpInteractPlayer) => interact.disconnect(player));
Events.on("playerLocationChanged", (player: HmpInteractPlayer) => interact.sync(player));
Events.on("resourceStop", (name?: string) => {
    if (!name || name === "hmp-interact") interact.stop();
    else interact.unregisterResource(name);
});

logger.info("interaction registry ready");
