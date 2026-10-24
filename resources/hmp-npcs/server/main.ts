import { loadConfig } from "./config";
import { createNpcsService } from "./service";
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpNpcMoveEndReason } from "../types";
import type { NativeNpcs } from "./internal";

declare const NPC: NativeNpcs;

const RESOURCE = "hmp-npcs";
const Hmp = Imports.get<HmpLibServer>("hmp-lib");
const logger = Hmp.logger.create(RESOURCE);
const service = createNpcsService({ config: loadConfig(Hmp), native: NPC, emit: (eventName, payload) => { Events.emit(eventName, payload); } });

Exports.register("catalog", service.catalog);
Exports.register("spawn", service.spawn);
Exports.register("destroy", service.destroy);
Exports.register("clear", service.clear);
Exports.register("get", service.get);
Exports.register("list", service.list);
Exports.register("status", service.status);
Exports.register("movement", service.movement);
Exports.register("setVirtualWorld", service.setVirtualWorld);

Events.on("npcDied", (id: number) => service.died(id));
// A host without NPC paths never raises these.
Events.on("npcWaypoint", (npc: { id: number }, index: number, lap: number) => service.waypoint(Number(npc?.id), index, lap));
Events.on("npcMoveEnded", (npc: { id: number }, reason: HmpNpcMoveEndReason) => service.moveEnded(Number(npc?.id), reason));
Events.on("resourceStop", (name?: string) => {
    if (!name || name === RESOURCE) service.stop();
    else service.clear(name);
});

logger.info(`NPC service ready: ${service.status().catalogSize} verified enemy definitions`);
