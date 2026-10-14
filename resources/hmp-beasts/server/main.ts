import configModule = require("./config");
import repositoryModule = require("./repository");
import schemaModule = require("./schema");
import serviceModule = require("./service");
import type { HmpCore } from "../../hmp-core/types";
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpMySQL } from "../../hmp-mysql/types";
import type { HmpBeastPlayer, HmpBeastPosition } from "../types";
import type { NativeBeasts, NativeCapturedBeast } from "./internal";

declare const Beast: Partial<NativeBeasts<HmpBeastPlayer>> | undefined;

const { loadConfig } = configModule;
const { createRepository } = repositoryModule;
const { createBeastService } = serviceModule;
const { migrations } = schemaModule;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const Hmp = Imports.get<HmpLibServer<HmpBeastPlayer>>("hmp-lib");
const database = Imports.get<HmpMySQL>("hmp-mysql");
const core = Imports.get<HmpCore<HmpBeastPlayer>>("hmp-core");
const logger = Hmp.logger.create("hmp-beasts");
const config = loadConfig(Hmp);
// A host without beast capture degrades at startup instead of failing to load.
const native = typeof Beast !== "undefined" && Beast !== null
    && (["bagOf", "giveCaptured", "takeCaptured", "create"] as const).every((name) => typeof Beast[name] === "function")
    ? Beast as NativeBeasts<HmpBeastPlayer>
    : null;
const service = createBeastService<HmpBeastPlayer>({
    config,
    native,
    repository: createRepository(database),
    migrations,
    core,
    players: () => PlayerManager.getAll() as HmpBeastPlayer[],
    emit: (eventName, payload) => { Events.emit(eventName, payload); },
    logger,
});

Exports.register("bag", service.bag);
Exports.register("status", service.status);

// The character events carry { session, character }; hmp:session:ended carries the session itself.
function sessionPlayer(payload: unknown): HmpBeastPlayer | null {
    if (!payload || typeof payload !== "object") return null;
    const session = "session" in payload ? payload.session : payload;
    return session && typeof session === "object" && "player" in session ? session.player as HmpBeastPlayer : null;
}

function characterId(payload: unknown): number | null {
    if (!payload || typeof payload !== "object" || !("character" in payload)) return null;
    const character = payload.character;
    const id = character && typeof character === "object" && "id" in character ? Number(character.id) : NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

Events.on("hmp:character:loaded", (payload: unknown) => {
    const player = sessionPlayer(payload);
    const id = characterId(payload);
    if (!player || id === null) return;
    service.attach(player, id).catch((error) => logger.warn(`Could not load #${player.id}'s beast bag: ${messageOf(error)}`));
});
Events.on("hmp:character:unloading", (payload: unknown) => {
    const player = sessionPlayer(payload);
    if (player) service.detach(player);
});
Events.on("hmp:session:ended", (session: unknown) => {
    const player = sessionPlayer(session);
    if (player) service.disconnect(player);
});
Events.on("beastCaptured", (player: HmpBeastPlayer, captured: NativeCapturedBeast) => {
    service.captured(player, captured).catch((error) => logger.warn(`Could not keep #${player.id}'s catch: ${messageOf(error)}`));
});
Events.on("beastReleased", (player: HmpBeastPlayer, released: NativeCapturedBeast, at: HmpBeastPosition) => {
    service.released(player, released, at).catch((error) => logger.warn(`Could not handle #${player.id}'s release: ${messageOf(error)}`));
});
Events.on("resourceStop", (name?: string) => { if (!name || name === "hmp-beasts") service.stop(); });
Events.on("resourceStart", (name?: string) => {
    if (name && name !== "hmp-beasts") return;
    if (!native) logger.error("This server build has no beast capture (Beast.giveCaptured); beast bags are not kept.");
    service.ready()
        .then(() => {
            const status = service.status();
            logger.info(`Beasts ready: ${status.loadedBags} bag(s) loaded; released beasts ${config.release.respawn ? `come back${config.release.capturable ? " and can be caught again" : ""}` : "are gone"}`);
        })
        .catch((error) => logger.error(`Startup failed: ${messageOf(error)}`));
});
