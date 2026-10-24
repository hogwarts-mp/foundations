import clientModule = require("./service");
import type { HmpLibClient } from "../../hmp-lib/types";
import type { NativeClientBlips } from "./internal";

declare const Blips: NativeClientBlips;

const { createBlipsClient } = clientModule;
const Hmp = Imports.get<HmpLibClient>("hmp-lib");
const logger = Hmp.logger.create("hmp-blips");
const client = createBlipsClient({ native: Blips, logger, emitServer: (name, payload) => { Events.emitServer(name, payload); } });

Exports.register("status", client.status);
Events.on("hmp-blips:set", client.set);
Events.on("hmp-blips:remove", client.remove);
Events.on("hmp-blips:replay", client.replay);
Events.on("hmp-blips:clear", client.clear);
Events.on("hmp-blips:pulse", client.pulse);
Events.on("hmp-blips:players", client.setPlayers);
Events.on("resourceStop", (name?: string) => { if (!name || name === "hmp-blips") client.stop(); });
Events.emitServer("hmp-blips:ready", "{}");

// The player's own map waypoint goes to the server. A host without Blips.waypoint has no waypoint reads, and
// reports nothing.
if (typeof Blips.waypoint === "function") {
    Events.on("waypointChanged", (waypoint: unknown) => { client.reportWaypoint(waypoint); });
    let current: HogwartsMpWaypoint | null = null;
    try { current = Blips.waypoint(); }
    catch (_) { /* no map state yet; waypointChanged reports the first one */ }
    if (current) client.reportWaypoint(current);
}

logger.info("Client marker coordinator ready");
