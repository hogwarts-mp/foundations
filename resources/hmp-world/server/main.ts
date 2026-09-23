import configModule = require("./config");
import serviceModule = require("./service");
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpWorldPlayer } from "../types";
import type { NativeWorld } from "./internal";

declare const World: NativeWorld;

const { loadConfig } = configModule;
const { createWorldService } = serviceModule;
const Hmp = Imports.get<HmpLibServer<HmpWorldPlayer>>("hmp-lib");
const logger = Hmp.logger.create("hmp-world");
const config = loadConfig(Hmp);
const world = createWorldService({
    config,
    native: World,
    events: Events,
    players: () => PlayerManager.getAll() as HmpWorldPlayer[],
});

Exports.register("environment", world.environment);
Exports.register("policy", world.policy);
Exports.register("status", world.status);

Events.onClient("hmp-world:ready", (player: HmpWorldPlayer) => world.clientReady(player));
Events.on("worldReady", (player: HmpWorldPlayer) => world.policy.sync(player));
Events.on("hmp:character:loaded", (payload: unknown) => {
    const session = payload && typeof payload === "object" && "session" in payload ? payload.session : null;
    const player = session && typeof session === "object" && "player" in session ? session.player as HmpWorldPlayer : null;
    if (player) world.policy.sync(player);
});
Events.on("playerDisconnect", (player: HmpWorldPlayer) => world.disconnect(player));
Events.on("resourceStop", (name?: string) => { if (!name || name === "hmp-world") world.stop(); });

const policy = world.policy.current();
logger.info(`World ready: ${config.environment.weather}, ${String(config.environment.time.hour).padStart(2, "0")}:${String(config.environment.time.minute).padStart(2, "0")}, boundaries ${policy.removeBoundaryVolumes ? "removed" : "preserved"}`);
