import configModule = require("./config");
import schemaModule = require("./schema");
import repositoryModule = require("./repository");
import registryModule = require("./registry");
import nativeModule = require("./native");
import inventoryModule = require("./inventory");
import transfersModule = require("./transfers");
import resourceModule = require("./resource");
import catalogModule = require("./native-catalog");
import startingItemsModule = require("./starting-items");
import errorsModule = require("./errors");
import type { HmpCoreSession } from "../../hmp-core/types";
import type { HmpInventoryUseTarget } from "../types";
import type { CharacterPayload, Player } from "./internal";

const { loadConfig } = configModule;
const { migrations } = schemaModule;
const { createRepository } = repositoryModule;
const { createItemRegistry } = registryModule;
const { createNativeBridge } = nativeModule;
const { createInventory } = inventoryModule;
const { createTransferService } = transfersModule;
const { createInventoryResource } = resourceModule;
const { createNativeItems } = catalogModule;
const { createStartingItemsGrant } = startingItemsModule;
const { messageOf } = errorsModule;

const Hmp = Imports.get("hmp-lib");
const database = Imports.get("hmp-mysql");
const core = Imports.get("hmp-core");
const logger = Hmp.logger.create("hmp-inventory");
const config = loadConfig(Hmp);
const repository = createRepository(database);
const registry = createItemRegistry();
const configuredItems = config.items as Array<Record<string, unknown>>;
const nativeItems = createNativeItems(typeof InventoryCatalog === "object" ? InventoryCatalog : null);
for (const definition of [...nativeItems, ...configuredItems.map((item) => ({ ...item, resource: item.resource || "hmp-inventory" }))]) registry.register(definition);
const native = createNativeBridge({ repository, core, logger });
const inventory = createInventory({ repository, registry, native, core, events: Events, config });
const transfers = createTransferService({ repository, registry, core, events: Events, config });
const resource = createInventoryResource({
    database, repository, registry, inventory, transfers, native, core, events: Events, config, migrations, logger,
    listPlayers: () => PlayerManager.getAll(),
});
const startingItems = createStartingItemsGrant(config.startingItems, { inventory, ready: resource.ready, logger });
const actions = Hmp.rateLimit.create<number>({ limit: 6, windowMs: 2000 });

for (const name of ["items", "inventory", "containers", "transfers", "native", "ui", "status"] as const) Exports.register(name, resource[name]);

Events.on("hmp:character:loading", (payload: unknown) => resource.onCharacterLoading(payload as CharacterPayload).catch((error: unknown) => logger.error(`Could not load inventory: ${messageOf(error)}`)));
Events.on("hmp:character:unloading", (payload: unknown) => resource.onCharacterUnloading(payload as CharacterPayload).catch((error: unknown) => logger.error(`Could not save inventory: ${messageOf(error)}`)));
Events.on("hmp:character:created", (payload: unknown) => startingItems.created(payload as CharacterPayload));
Events.on("hmp:character:loaded", (payload: unknown) => {
    const value = payload as CharacterPayload;
    startingItems.loaded(value).catch((error: unknown) => logger.error(`Could not grant starting items to character ${value?.character?.id}: ${messageOf(error)}`));
});
Events.on("hmp:character:deleted", (payload: unknown) => startingItems.deleted(payload as CharacterPayload));
Events.on("hmp:session:ended", (session: unknown) => resource.disconnect((session as HmpCoreSession<Player>).player));
Events.on("playerInventoryUpdated", (player: unknown, rows: unknown) => resource.onNativeUpdated(player as Player, rows).catch((error: unknown) => logger.warn(`Could not persist native inventory: ${messageOf(error)}`)));
Events.on("hmp:inventory:changed", (payload: unknown) => {
    const player = payload && typeof payload === "object" && "player" in payload ? payload.player as Player : null;
    if (player && resource.ui.isOpen(player)) resource.ui.refresh(player).catch((error: unknown) => logger.warn(`Could not refresh inventory: ${messageOf(error)}`));
});

Events.onClient("hmp-inventory:ready", (player) => resource.onClientReady(player));
Events.onClient("hmp-inventory:close", (player) => resource.ui.close(player));
Events.onClient("hmp-inventory:refresh", (player) => {
    if (!actions.allow(player.id)) return;
    resource.ui.refresh(player).catch((error: unknown) => player.emit("hmp-inventory:error", JSON.stringify({ message: messageOf(error) })));
});
Events.onClient("hmp-inventory:use", (player, raw) => {
    if (!actions.allow(player.id)) return;
    let payload: unknown = {};
    try { payload = JSON.parse((raw || "{}") as string) as unknown; } catch (_) {}
    const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const target: number | HmpInventoryUseTarget = value.source === "native"
        ? { source: "native", itemId: String(value.itemId || ""), variation: String(value.variation || "") }
        : Number(value.slot);
    resource.inventory.use(player, target)
        .then(() => resource.ui.refresh(player))
        .catch((error: unknown) => player.emit("hmp-inventory:error", JSON.stringify({ message: messageOf(error) })));
});

if (config.allowInventoryCommand) Events.on("chatCommand", (player: unknown, _message: unknown, command: unknown) => {
    const currentPlayer = player as Player;
    if (!["inventory", "hmpinv"].includes(String(command || "").toLowerCase())) return;
    resource.ui.open(currentPlayer).catch((error: unknown) => {
        logger.warn(`Could not open inventory for #${currentPlayer.id}: ${messageOf(error)}`);
        if (typeof currentPlayer.sendChat === "function") currentPlayer.sendChat(`[inventory] ${messageOf(error)}`);
    });
});

let autoSaveTimer = config.autoSaveMs > 0 ? setInterval(() => resource.saveAll().catch((error: unknown) => logger.warn(`Inventory autosave failed: ${messageOf(error)}`)), config.autoSaveMs) : null;
if (autoSaveTimer && typeof autoSaveTimer.unref === "function") autoSaveTimer.unref();

Events.on("resourceStop", (name: unknown) => {
    if (name && name !== "hmp-inventory") { resource.removeForResource(name as string); return; }
    if (autoSaveTimer) { clearInterval(autoSaveTimer); autoSaveTimer = null; }
    resource.stop().catch((error: unknown) => logger.error(`Inventory shutdown failed: ${messageOf(error)}`));
});

Events.on("resourceStart", async (name: unknown) => {
    if (name && name !== "hmp-inventory") return;
    await resource.ready();
    logger.info(`Inventory ready with ${resource.status().itemDefinitions} item definition(s)`);
});
// TypeScript source.
