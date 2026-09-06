import commandsModule = require("./commands");
import configModule = require("./config");
import repositoryModule = require("./repository");
import schemaModule = require("./schema");
import serviceModule = require("./service");
import type { DutyEvent, Player, ShopTradeEvent } from "./internal";

const { registerCommands } = commandsModule;
const { loadConfig } = configModule;
const { createRepository } = repositoryModule;
const { migrations } = schemaModule;
const { createBusinessService } = serviceModule;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const Hmp = Imports.get("hmp-lib");
const database = Imports.get("hmp-mysql");
const core = Imports.get("hmp-core");
const inventory = Imports.get("hmp-inventory");
const interact = Imports.get("hmp-interact");
const ui = Imports.get("hmp-ui");
const banking = Imports.get("hmp-banking");
const shops = Imports.get("hmp-shops");
const jobs = Imports.get("hmp-jobs");
const logger = Hmp.logger.create("hmp-business");
const config = loadConfig(Hmp);
const repository = createRepository(database);
const business = createBusinessService({ repository, core, inventory, interact, ui, banking, shops, jobs, lib: Hmp, events: Events, logger, migrations, config });

for (const name of ["businesses", "shops", "offers", "stock", "books", "ui", "audit", "status"] as const) Exports.register(name, business[name]);

Events.on("hmp:jobs:duty", (event: DutyEvent) => business.onDuty(event));
Events.on("hmp:shop:purchased", (event: ShopTradeEvent) => { business.onPurchased(event).catch((error) => logger.warn(`Purchase listener failed: ${messageOf(error)}`)); });
Events.on("hmp:shop:sold", (event: ShopTradeEvent) => business.onSold(event));
Events.on("playerDisconnect", (player: Player) => business.disconnect(player));
Events.on("resourceStop", (name?: string) => {
    if (!name || name === "hmp-business") business.stop().catch((error) => logger.error(`Shutdown failed: ${messageOf(error)}`));
});

if (config.commands.enabled) {
    const router = Hmp.command.createRouter({ logger, prefix: "[business]" });
    registerCommands({ router, service: business, core, config: config.commands, logger });
    Events.on("chatCommand", router.handle);
}

Events.on("resourceStart", async (name?: string) => {
    if (name && name !== "hmp-business") { business.onResourceStart(name); return; }
    await business.start();
    logger.info("Businesses, counters, offers and the management ledger ready");
    if (config.businesses.length) {
        const created = await business.seed(config.businesses);
        if (created) logger.info(`Created ${created}/${config.businesses.length} configured business(es)`);
    }
});
