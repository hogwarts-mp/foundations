import configModule = require("./config");
import spawnModule = require("./spawn");
import type { HmpCoreSession } from "../../hmp-core/types";
import type { CharacterSelectionPayload, Player } from "./internal";

const { loadConfig } = configModule;
const { createSpawnFlow } = spawnModule;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const Hmp = Imports.get("hmp-lib");
const core = Imports.get("hmp-core");
const logger = Hmp.logger.create("hmp-spawn");
const config = loadConfig(Hmp);
const flow = createSpawnFlow({ core, events: Events, logger, config });
const actions = Hmp.rateLimit.create<number>({ limit: 5, windowMs: 2000 });

Exports.register("locations", flow.locations);
Exports.register("ui", flow.ui);
Exports.register("spawn", flow.spawn);
Exports.register("status", flow.status);

Events.on("hmp:character:selected", (payload: unknown) => flow.onCharacterSelected(payload as CharacterSelectionPayload).catch((error: unknown) => {
    logger.error(`Could not open spawn selection: ${messageOf(error)}`);
    const player = payload && typeof payload === "object" && "session" in payload && payload.session && typeof payload.session === "object" && "player" in payload.session ? payload.session.player as Player : null;
    player?.emit("hmp-spawn:failed", JSON.stringify({ status: -1, message: messageOf(error) }));
}));
Events.on("hmp:character:unloading", (payload: unknown) => {
    const value = payload as CharacterSelectionPayload;
    return flow.save(value.session.player, value.character).catch((error: unknown) => logger.warn(`Could not save location: ${messageOf(error)}`));
});
Events.on("playerTeleportComplete", (player: unknown, requestId: unknown, status: unknown, completion: unknown) => flow.complete(player as Player, requestId, status, completion).catch((error: unknown) => logger.error(`Spawn completion failed: ${messageOf(error)}`)));
Events.on("playerLocationChanged", (player: Player, current: HogwartsMpPlayerLocation | null, previous: HogwartsMpPlayerLocation | null) => flow.locationChanged(player, current, previous).catch((error: unknown) => logger.warn(`Could not save location context: ${messageOf(error)}`)));
Events.on("hmp:session:ended", (session: unknown) => flow.disconnect((session as HmpCoreSession<Player>).player));
Events.on("resourceStop", (name: unknown) => {
    if (name && name !== "hmp-spawn") return flow.removeForResource(name as string);
    if (autoSaveTimer) clearInterval(autoSaveTimer);
    return flow.saveAll(PlayerManager.getAll());
});

Events.on("loadingFinished", (player: unknown) => flow.onLoadingFinished(player as Player).catch((error: unknown) => logger.error(`Client readiness failed: ${messageOf(error)}`)));
Events.onClient("hmp-spawn:select", (player, payload) => {
    if (!actions.allow(player.id)) return player.emit("hmp-spawn:failed", JSON.stringify({ status: -1, message: "Please slow down." }));
    const key = payload && typeof payload === "object" && "key" in payload ? payload.key : undefined;
    flow.select(player, key).catch((error: unknown) => {
        logger.warn(`Spawn selection for #${player.id} failed: ${messageOf(error)}`);
        player.emit("hmp-spawn:failed", JSON.stringify({ status: -1, message: messageOf(error) }));
    });
});

const autoSaveTimer = config.autoSaveMs > 0
    ? setInterval(() => flow.saveAll(PlayerManager.getAll()), config.autoSaveMs)
    : null;
if (autoSaveTimer && typeof autoSaveTimer.unref === "function") autoSaveTimer.unref();

logger.info(`Spawn flow ready with ${flow.status().locations} location(s)`);
// TypeScript source.
