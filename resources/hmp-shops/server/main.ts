import configModule = require("./config");
import repositoryModule = require("./repository");
import schemaModule = require("./schema");
import serviceModule = require("./service");
import type { Player } from "./internal";

const { loadConfig } = configModule;
const { createRepository } = repositoryModule;
const { migrations } = schemaModule;
const { createShopsService } = serviceModule;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const Hmp = Imports.get("hmp-lib");
const database = Imports.get("hmp-mysql");
const core = Imports.get("hmp-core");
const inventory = Imports.get("hmp-inventory");
const interact = Imports.get("hmp-interact");
const ui = Imports.get("hmp-ui");
const logger = Hmp.logger.create("hmp-shops");
const repository = createRepository(database);
const shops = createShopsService({ repository, core, inventory, interact, ui, events: Events, logger, migrations });

for (const name of ["shops", "currencies", "transactions", "stock", "status"] as const) Exports.register(name, shops[name]);

Events.on("playerDisconnect", (player: Player) => shops.disconnect(player));
Events.on("resourceStop", (name?: string) => {
    if (!name || name === "hmp-shops") {
        shops.stop().catch((error) => logger.error(`Shutdown failed: ${messageOf(error)}`));
        return;
    }
    shops.removeForResource(name);
});

Events.on("resourceStart", async (name?: string) => {
    if (name && name !== "hmp-shops") return;
    await shops.start();
    logger.info("Shop registry, stock and transaction ledger ready");
    registerConfiguredShops();
});

// Shops declared in data/hmp-shops.json. Registered after start so their items already exist in
// hmp-inventory; one bad entry is logged and skipped rather than taking the others down with it.
function registerConfiguredShops(): void {
    let config: ReturnType<typeof loadConfig>;
    try { config = loadConfig(Hmp); }
    catch (error) {
        logger.error(`Shop configuration not loaded: ${messageOf(error)}`);
        return;
    }
    let registered = 0;
    for (const shop of config.shops) {
        try { shops.shops.register(shop); registered++; }
        catch (error) { logger.error(`Configured shop '${shop.id}' not registered: ${messageOf(error)}`); }
    }
    if (config.shops.length) logger.info(`Registered ${registered}/${config.shops.length} configured shop(s)`);
}
