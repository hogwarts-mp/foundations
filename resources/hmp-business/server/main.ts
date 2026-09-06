import commandsModule = require("./commands");
import configModule = require("./config");
import repositoryModule = require("./repository");
import schemaModule = require("./schema");
import serviceModule = require("./service");
import screenModule = require("./screen");
import type { DutyEvent, Player, ShopTradeEvent } from "./internal";

const { registerCommands } = commandsModule;
const { loadConfig } = configModule;
const { createRepository } = repositoryModule;
const { migrations } = schemaModule;
const { createBusinessService } = serviceModule;
const { createBusinessScreen } = screenModule;
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
const screen = createBusinessScreen({ service: business, core, inventory, banking, jobs, prices: config.prices, adminGroups: config.commands.adminGroups, logger });
const screenActions = Hmp.rateLimit.create<number>({ limit: 8, windowMs: 2000 });

for (const name of ["businesses", "shops", "offers", "stock", "books", "ui", "audit", "status"] as const) Exports.register(name, business[name]);

Events.on("hmp:jobs:duty", (event: DutyEvent) => { business.onDuty(event); screen.refreshAll(); });
Events.on("hmp:shop:purchased", (event: ShopTradeEvent) => {
    business.onPurchased(event)
        .then(() => screen.refreshAll())
        .catch((error) => logger.warn(`Purchase listener failed: ${messageOf(error)}`));
});
Events.on("hmp:shop:sold", (event: ShopTradeEvent) => { business.onSold(event); screen.refreshAll(); });
Events.on("playerDisconnect", (player: Player) => { screen.disconnect(player); business.disconnect(player); });
Events.onClient("hmp-business:ready", () => undefined);
Events.onClient("hmp-business:close", (player: Player) => screen.hide(player));
Events.onClient("hmp-business:refresh", (player: Player) => { if (screenActions.allow(player.id)) screen.refresh(player).catch((error) => player.emit("hmp-business:error", JSON.stringify({ message: messageOf(error) }))); });
Events.onClient("hmp-business:action", (player: Player, raw: unknown) => {
    if (!screenActions.allow(player.id)) { player.emit("hmp-business:error", JSON.stringify({ message: "Please slow down." })); return; }
    let payload: unknown = {};
    try { payload = JSON.parse(String(raw || "{}")) as unknown; } catch (_) {}
    screen.perform(player, payload);
});
Events.on("resourceStop", (name?: string) => {
    if (!name || name === "hmp-business") business.stop().catch((error) => logger.error(`Shutdown failed: ${messageOf(error)}`));
});

if (config.commands.enabled) {
    const router = Hmp.command.createRouter({ logger, prefix: "[business]" });
    registerCommands({ router, service: business, core, config: config.commands, logger, open: screen.show });
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
