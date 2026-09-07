import serviceModule = require("./service");
import type { HmpLibClient } from "../../hmp-lib/types";
import type { HmpNativeBreakables } from "../types";

declare const Breakables: HmpNativeBreakables | undefined;

const { createWorldStateClient } = serviceModule;
const Hmp = Imports.get<HmpLibClient>("hmp-lib");
const logger = Hmp.logger.create("hmp-worldstate");
const client = createWorldStateClient({
    breakables: typeof Breakables === "undefined" ? null : Breakables,
    events: Events,
    notify: (message: string) => Game.notify(message),
    log: (message: string) => logger.info(message),
    warn: (message: string) => logger.warn(message),
});

Exports.register("status", client.status);
Exports.register("state", client.state);
Exports.register("breakables", client.breakables);

Events.on("hmp-worldstate:sync", (payload: unknown) => { if (!client.sync(payload)) logger.warn("Rejected malformed world-state sync"); });
Events.on("hmp-worldstate:change", (payload: unknown) => { if (!client.change(payload)) logger.warn("Rejected malformed world-state change"); });
Events.on("hmp-worldstate:clear", (payload: unknown) => { void client.clear(payload); });
Events.on("hmp-worldstate:diagnostic", (payload: unknown) => { void client.diagnostic(payload); });
// Native: the LOCAL player's own Reparo finished / spell broke a repairable (remote applies are filtered natively).
Events.on("breakableState", (uid: unknown, state: unknown, cls: unknown) => { void client.report(uid, state, cls); });
Events.on("resourceStop", (name?: string) => { if (!name || name === "hmp-worldstate") client.stop(); });

client.start();
logger.info("Client world-state coordinator ready");
