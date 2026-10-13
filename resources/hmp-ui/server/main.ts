import uiModule = require("./ui");
import type { HmpUiPlayer } from "../types";

const { createUiService } = uiModule;
const Hmp = Imports.get("hmp-lib");
const logger = Hmp.logger.create("hmp-ui");
const ui = createUiService<HmpUiPlayer>({ logger });

for (const name of ["notify", "alert", "input", "context", "progress", "close", "status"] as const) Exports.register(name, ui[name]);

Events.onClient("hmp-ui:response", (player, payload) => ui.onResponse(player, payload));
Events.onClient("hmp-ui:change", (player, payload) => ui.onChange(player, payload));
Events.on("playerDisconnect", (player: HmpUiPlayer) => ui.disconnect(player));
Events.on("resourceStop", (name?: string) => {
    if (!name || name === "hmp-ui") ui.stop();
});

logger.info("UI primitives ready");
