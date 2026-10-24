import clientModule = require("./interact");
import type { HmpLibClient } from "../../hmp-lib/types";

const { createInteractClient } = clientModule;
const Hmp = Imports.get<HmpLibClient>("hmp-lib");
const interact = createInteractClient({
    events: Events,
    input: Hmp.input,
    hud: Hud,
    localPlayer: LocalPlayer,
    game: Game,
    shapes: typeof Shapes === "undefined" ? undefined : Shapes,
});

Exports.register("setEnabled", interact.setEnabled);
Exports.register("status", interact.status);

Events.on("resourceStop", (name?: string) => {
    if (!name || name === "hmp-interact") interact.stop();
});

console.info("[hmp-interact] client prompt coordinator ready");
