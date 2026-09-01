import configModule = require("./config");
import charactersModule = require("./characters");
import type { HmpCoreSession } from "../../hmp-core/types";
import type { CharacterEventPayload, CharacterNameInput, Player } from "./internal";

const { loadConfig } = configModule;
const { createCharacterFlow } = charactersModule;

const Hmp = Imports.get("hmp-lib");
const core = Imports.get("hmp-core");
const logger = Hmp.logger.create("hmp-characters");
const config = loadConfig(Hmp);
const flow = createCharacterFlow({ core, events: Events, logger, config });
const actions = Hmp.rateLimit.create<number>({ limit: 8, windowMs: 2000 });

const ui = Object.freeze({ open: flow.open, close: flow.close });
Exports.register("ui", ui);

function action(handler: (player: Player, payload: Record<string, unknown>) => unknown) {
    return (player: Player, payload: unknown) => {
        if (!actions.allow(player.id)) return flow.notifyError(player, new Error("Please slow down."));
        const data = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
        Promise.resolve(handler(player, data)).catch((error: unknown) => flow.notifyError(player, error));
    };
}

Events.on("hmp:session:ready", (session: unknown) => {
    const value = session as HmpCoreSession<Player>;
    flow.onSessionReady(value).catch((error: unknown) => flow.notifyError(value.player, error));
});
Events.on("hmp:character:loading", (payload: unknown) => flow.applyAppearance(payload as CharacterEventPayload));
Events.on("playerAppearanceChanged", (player: unknown, blob: unknown, revision: unknown) => {
    flow.onAppearanceChanged(player as Player, blob, revision).catch((error: unknown) => flow.notifyError(player as Player, error));
});
Events.on("worldReady", (player: unknown) => flow.onWorldReady(player as Player).catch((error: unknown) => flow.notifyError(player as Player, error)));
Events.on("playerDisconnect", (player: unknown) => flow.disconnect(player as Player));

Events.on("loadingFinished", (player: unknown) => flow.onLoadingFinished(player as Player));
Events.onClient("hmp-characters:select", action((player, payload) => flow.select(player, payload?.characterId)));
Events.onClient("hmp-characters:create", action((player) => flow.beginCreate(player)));
Events.onClient("hmp-characters:confirmed", action((player, payload) => flow.confirmCreate(player, payload as CharacterNameInput)));
Events.onClient("hmp-characters:cancelled", action((player) => flow.cancelCreate(player)));
Events.onClient("hmp-characters:delete", action((player, payload) => flow.remove(player, payload?.characterId)));
Events.onClient("hmp-characters:close", action((player) => {
    if (!core.characters.active(player) || config.allowCloseWithActiveCharacter !== true) throw new Error("Choose a character before entering the world.");
    flow.close(player);
}));

if (config.command) {
    const commands = Hmp.command.createRouter({ logger, prefix: "[characters]" });
    commands.register(config.command, { description: "Open character selection." }, ({ player }) => flow.open(player, { mode: "wardrobe" }));
    Events.on("chatCommand", commands.handle);
}

logger.info("Character selection flow ready");
// TypeScript source.
