import assert = require("node:assert");
import { test } from "node:test";
import registryModule = require("../server/registry");
import inventoryModule = require("../server/inventory");
import transfersModule = require("../server/transfers");
import nativeModule = require("../server/native");
import catalogModule = require("../server/native-catalog");
import resourceModule = require("../server/resource");
import type { HmpNativeInventoryRow } from "../types";
import type { Core, Database, InventoryConfig, InventoryContainer, NativeBridge, Player, Repository } from "../server/internal";

const { createItemRegistry } = registryModule;
const { createInventory } = inventoryModule;
const { createTransferService } = transfersModule;
const { createNativeBridge } = nativeModule;
const { createNativeItems } = catalogModule;
const { createInventoryResource } = resourceModule;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function hasCode(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

function catalogOf(definitions: HogwartsMpInventoryCatalogDefinition[]): HogwartsMpInventoryCatalog {
    return {
        info: () => ({ schemaVersion: 1, gameBuild: "test", definitions: definitions.length }),
        get: (itemId) => definitions.find((item) => item.itemId.toLowerCase() === itemId.toLowerCase()) || null,
        has: (itemId) => definitions.some((item) => item.itemId.toLowerCase() === itemId.toLowerCase()),
        list: () => definitions,
        holderPair: () => null,
    };
}

function setup() {
    const stores = new Map<string, InventoryContainer>();
    let nextId = 1;
    const repository: Repository = {
        async ensureContainer(spec) {
            if (!stores.has(spec.key)) stores.set(spec.key, { id: nextId++, ...clone(spec), characterId: spec.characterId ?? null, metadata: spec.metadata ?? {}, items: [] });
            return clone(stores.get(spec.key)!);
        },
        async createNamedContainer(spec) { return this.ensureContainer(spec); },
        async getContainer(key) { return stores.has(key) ? clone(stores.get(key)!) : null; },
        async mutateContainer<T>(key: string, work: (container: InventoryContainer) => T | Promise<T>) {
            const draft = clone(stores.get(key)!);
            const result = await work(draft);
            stores.set(key, draft);
            return { container: clone(draft), result };
        },
        async mutateContainers<T>(keys: string[], work: (containers: Map<string, InventoryContainer>) => T | Promise<T>) {
            const wanted = [...new Set(keys)].sort();
            const drafts = new Map(wanted.map((key) => [key, clone(stores.get(key)!)]));
            if ([...drafts.values()].some((container) => !container)) throw new Error("test container not found");
            const result = await work(drafts);
            for (const [key, container] of drafts) stores.set(key, clone(container));
            return { containers: wanted.map((key) => clone(drafts.get(key)!)), result };
        },
        async deleteContainer(key) { return stores.delete(key); },
        async loadNative() { return []; },
        async saveNative(_characterId, rows) { return clone(rows); },
    };
    const registry = createItemRegistry();
    for (const item of createNativeItems(catalogOf([
        { itemId: "WoundCleaning", itemType: "PotionUsable", holder: "HealthPotionStorage", maxStack: 25, kind: "item", inventoryable: true, persistent: true, consumable: true, usableFromInventory: true },
    ]))) registry.register(item);
    const nativeRows: HmpNativeInventoryRow[] = [];
    const nativeUses: Array<{ itemId: string; variation?: string }> = [];
    const native: NativeBridge = {
        list: () => clone(nativeRows),
        async give(_player, definition, amount) { nativeRows.push({ itemId: String(definition?.nativeId), holder: String(definition?.holder), count: amount }); return amount; },
        async remove(_player, definition, amount) {
            const row = nativeRows.find((item) => item.itemId === definition?.nativeId);
            if (!row || row.count < amount) throw new Error("not enough");
            row.count -= amount;
            if (!row.count) nativeRows.splice(nativeRows.indexOf(row), 1);
            return amount;
        },
        async use(_player, definition, options) {
            nativeUses.push({ itemId: String(definition?.nativeId), variation: options?.variation });
            const row = nativeRows.find((item) => item.itemId === definition?.nativeId && (!options?.variation || item.variation === options.variation));
            if (!row || row.count < 1) throw new Error("not enough");
            row.count--;
            if (!row.count) nativeRows.splice(nativeRows.indexOf(row), 1);
            return true;
        },
        async attach() { return true; },
        async save() { return true; },
        async onUpdated() { return true; },
        detach() { return true; },
        async flush() {},
        status: () => ({ active: 0, pendingWrites: 0 }),
    };
    const clientEvents: Array<{ name: string; payload: unknown }> = [];
    const player: Player = { id: 7, nickname: "Poppy", position: { x: 0, y: 0, z: 0 }, emit(name, payload) { clientEvents.push({ name, payload }); }, teleport: () => 0 };
    const character = { id: 12, name: "Poppy Sweeting" };
    const emitted: Array<{ name: string; payload: unknown }> = [];
    const core = { characters: { active: (candidate: Player) => candidate === player ? character : null } } as unknown as Core;
    const events = { emit: (name: string, payload: unknown) => emitted.push({ name, payload }) };
    const config: InventoryConfig = {
        slots: 3,
        maxWeight: 5,
        autoSaveMs: 0,
        allowInventoryCommand: true,
        items: [],
        ui: { url: "fw://resources/hmp-inventory/dist/index.html" },
    };
    const service = createInventory({ repository, registry, native, core, events, config });
    const transfers = createTransferService({ repository, registry, core, events, config });
    return { inventory: service.api, service, transfers, repository, registry, native, nativeRows, nativeUses, stores, player, character, core, events, config, emitted, clientEvents };
}

test("builds native definitions from InventoryCatalog while preserving curated aliases", () => {
    const definitions: HogwartsMpInventoryCatalogDefinition[] = [
        { itemId: "WoundCleaning", itemType: "PotionUsable", holder: "HealthPotionStorage", maxStack: 25, kind: "item", inventoryable: true, persistent: true, consumable: true, usableFromInventory: true },
        { itemId: "Back_001_Common", itemType: "GearStated", holder: "ActorBackpack", maxStack: 1, kind: "gear", inventoryable: true, persistent: true, consumable: false, usableFromInventory: false },
        { itemId: "Knuts", itemType: "SPECIAL", holder: "ResourceInventory", maxStack: 999999, kind: "item", inventoryable: true, persistent: false, consumable: false, usableFromInventory: false },
    ];
    const items = createNativeItems(catalogOf(definitions));
    assert.strictEqual(items[0].name, "native:wiggenweld_potion");
    assert.strictEqual(items[0].usable, true);
    assert.strictEqual(items[1].name, "native:back_001_common");
    assert.strictEqual(items[1].kind, "gear");
    assert.strictEqual(items[2].name, "native:galleons");
    assert.deepStrictEqual(items[2].aliases, ["native:knuts"]);
    assert.match(String(items[2].icon), /coin\.svg$/);
    const registry = createItemRegistry();
    registry.register(items[2]);
    assert.strictEqual(registry.get("native:galleons")?.name, "native:galleons");
    assert.strictEqual(registry.get("native:knuts")?.name, "native:galleons");
    assert.strictEqual(registry.get("Knuts")?.name, "native:galleons");
    assert.strictEqual(registry.get("KNUTS")?.name, "native:galleons");
    assert.strictEqual(registry.fromNative("Knuts")?.name, "native:galleons");
    assert.strictEqual(registry.list().length, 1);
    assert.throws(() => registry.register({ name: "native:knuts", nativeId: "OtherCurrency", resource: "test" }), /already an alias/);
});

test("custom items stack by name and metadata and expose icon-ready rows", async () => {
    const { inventory, registry, player } = setup();
    registry.register({ name: "sealed_letter", label: "Sealed Letter", icon: "http://example/items/letter.png", maxStack: 2, weight: 1, resource: "test" });
    await inventory.add(player, "sealed_letter", 3, { metadata: { seal: "red" } });
    let view = await inventory.get(player);
    assert.deepStrictEqual(view.custom.map((row) => [row.slot, row.amount, row.metadata.seal]), [[1, 2, "red"], [2, 1, "red"]]);
    assert.strictEqual(view.weight, 3);
    assert.strictEqual(view.custom[0].icon, "http://example/items/letter.png");

    await inventory.add(player, "sealed_letter", 1, { metadata: { seal: "blue" } });
    view = await inventory.get(player);
    assert.strictEqual(view.usedSlots, 3);
    assert.strictEqual(await inventory.count(player, "sealed_letter"), 4);
    assert.strictEqual(await inventory.count(player, "sealed_letter", { metadata: { seal: "blue" } }), 1);
});

test("capacity failures are atomic", async () => {
    const { inventory, registry, player } = setup();
    registry.register({ name: "stone", label: "Heavy Stone", maxStack: 10, weight: 3, resource: "test" });
    await inventory.add(player, "stone", 1);
    await assert.rejects(() => inventory.add(player, "stone", 1), (error) => hasCode(error, "HMP_INVENTORY_OVERWEIGHT"));
    assert.strictEqual(await inventory.count(player, "stone"), 1);

    registry.register({ name: "unique_note", unique: true, weight: 0, resource: "test" });
    await inventory.add(player, "unique_note", 2);
    await assert.rejects(() => inventory.add(player, "unique_note", 1), (error) => hasCode(error, "HMP_INVENTORY_FULL"));
    assert.strictEqual(await inventory.count(player, "unique_note"), 2);
});

test("native potion grants stay in the game bridge and appear in the unified view", async () => {
    const { inventory, nativeRows, player } = setup();
    await inventory.add(player, "native:wiggenweld_potion", 3);
    assert.deepStrictEqual(nativeRows, [{ itemId: "WoundCleaning", holder: "HealthPotionStorage", count: 3 }]);
    const view = await inventory.get(player);
    assert.strictEqual(view.custom.length, 0);
    assert.strictEqual(view.native[0].label, "Wiggenweld Potion");
    assert.strictEqual(view.native[0].source, "native");
    assert.strictEqual(await inventory.has(player, "native:wiggenweld_potion", 3), true);
});

test("the unified view counts native rows toward usedSlots and weight", async () => {
    const { inventory, registry, player } = setup();
    registry.register({ name: "sealed_letter", label: "Sealed Letter", maxStack: 5, weight: 1, resource: "test" });
    await inventory.add(player, "sealed_letter", 2);
    assert.strictEqual((await inventory.get(player)).usedSlots, 1);

    await inventory.add(player, "native:wiggenweld_potion", 3);
    const view = await inventory.get(player);
    assert.strictEqual(view.native.length, 1);
    assert.strictEqual(view.usedSlots, 2);
    assert.strictEqual(view.weight, 2);
});

test("native use routes through the Framework and waits for its accepted decrement", async () => {
    const { inventory, nativeRows, nativeUses, player, emitted } = setup();
    await inventory.add(player, "native:wiggenweld_potion", 2);
    assert.strictEqual((await inventory.get(player)).native[0].usable, true);
    assert.strictEqual(await inventory.use(player, { source: "native", itemId: "WoundCleaning" }), true);
    assert.deepStrictEqual(nativeUses, [{ itemId: "WoundCleaning", variation: "" }]);
    assert.strictEqual(nativeRows[0].count, 1);
    assert.ok(emitted.some((event) => event.name === "hmp:inventory:used"));
});

test("usable custom items are consumed only after an accepted server handler", async () => {
    const { inventory, registry, player, emitted } = setup();
    let uses = 0;
    registry.register({ name: "tonic", maxStack: 4, consumable: true, resource: "test", use: async () => { uses++; } });
    await inventory.add(player, "tonic", 2);
    assert.strictEqual(await inventory.use(player, 1), true);
    assert.strictEqual(uses, 1);
    assert.strictEqual(await inventory.count(player, "tonic"), 1);
    assert.ok(emitted.some((event) => event.name === "hmp:inventory:used"));
});

test("slot moves swap occupied custom slots without touching native rows", async () => {
    const { inventory, registry, player } = setup();
    registry.register({ name: "letter", maxStack: 1, resource: "test" });
    registry.register({ name: "badge", maxStack: 1, resource: "test" });
    await inventory.add(player, "letter");
    await inventory.add(player, "badge");
    await inventory.move(player, 1, 2);
    assert.deepStrictEqual((await inventory.get(player)).custom.map((row) => [row.slot, row.name]), [[1, "badge"], [2, "letter"]]);
});

test("atomically transfers exact custom stacks between character and named containers", async () => {
    const { inventory, transfers, repository, registry, player, stores, emitted } = setup();
    registry.register({ name: "sealed_letter", label: "Sealed Letter", maxStack: 2, weight: 1, resource: "test" });
    await inventory.add(player, "sealed_letter", 3, { metadata: { seal: "red" } });
    await repository.createNamedContainer({ key: "stash:owlery", label: "Owlery", slots: 4, maxWeight: 10, metadata: { kind: "stash" } });

    const moved = await transfers.move({ from: player, to: "stash:owlery", fromSlot: 1, amount: 1, toSlot: 3 });
    assert.strictEqual(moved.item, "sealed_letter");
    assert.strictEqual(moved.amount, 1);
    assert.deepStrictEqual(moved.metadata, { seal: "red" });
    assert.deepStrictEqual(stores.get("character:12")?.items.map((row) => [row.slot, row.amount]), [[1, 1], [2, 1]]);
    assert.deepStrictEqual(stores.get("stash:owlery")?.items.map((row) => [row.slot, row.amount]), [[3, 1]]);
    assert.ok(emitted.some((event) => event.name === "hmp:inventory:transferred"));
});

test("rolls both containers back when destination capacity rejects a transfer", async () => {
    const { inventory, transfers, repository, registry, player, stores } = setup();
    registry.register({ name: "stone", label: "Heavy Stone", maxStack: 10, weight: 2, resource: "test" });
    await inventory.add(player, "stone", 2);
    await repository.createNamedContainer({ key: "stash:tiny", label: "Tiny Box", slots: 1, maxWeight: 1, metadata: {} });
    const before = clone([...stores.entries()]);
    await assert.rejects(() => transfers.move({ from: player, to: "stash:tiny", fromSlot: 1, amount: 1 }), (error) => hasCode(error, "HMP_INVENTORY_OVERWEIGHT"));
    assert.deepStrictEqual([...stores.entries()], before);
});

test("refuses to treat a native definition as a database-container item", async () => {
    const { transfers, repository, player, stores } = setup();
    await repository.ensureContainer({ key: "character:12", characterId: 12, label: "Inventory", slots: 3, maxWeight: 5, metadata: {} });
    await repository.createNamedContainer({ key: "stash:test", label: "Test", slots: 3, maxWeight: 5, metadata: {} });
    stores.get("character:12")!.items.push({ slot: 1, name: "native:wiggenweld_potion", amount: 1, metadata: {} });
    await assert.rejects(() => transfers.move({ from: player, to: "stash:test", fromSlot: 1 }), (error) => hasCode(error, "HMP_INVENTORY_NATIVE_TRANSFER_UNSUPPORTED"));
    assert.strictEqual(stores.get("character:12")!.items[0].amount, 1);
    assert.strictEqual(stores.get("stash:test")!.items.length, 0);
});

test("native snapshots disable identity persistence and restore per character", async () => {
    const calls: unknown[][] = [];
    const saved: Array<{ characterId: number; rows: HmpNativeInventoryRow[] }> = [];
    interface TestInventory extends HogwartsMpNativeInventory { rows: HmpNativeInventoryRow[] }
    const inventory: TestInventory = {
            rows: [],
            revision: 1,
            persist(value, callback) { calls.push(["persist", value]); callback?.(null, { revision: this.revision, rows: this.rows.length }); },
            replace(rows, callback) { calls.push(["replace", clone(rows)]); this.rows = clone(rows); Object.defineProperty(this, "revision", { value: 2, writable: true }); callback?.(null, { revision: this.revision, rows: this.rows.length }); },
            list() { return clone(this.rows); },
            count: () => 0,
            has: () => false,
            clear(callback) { this.rows = []; callback?.(null, { revision: this.revision, rows: 0 }); },
            native: () => ({ items: clone(inventory.rows), sequence: 1, appliedRevision: inventory.revision, applyErrors: [] }),
            async waitForRevision(revision) { calls.push(["waitForRevision", revision]); return { items: clone(this.rows), sequence: 1, appliedRevision: revision, applyErrors: [] }; },
            give(_itemId, _amount, _options, callback) { callback?.(null, { revision: this.revision, rows: this.rows.length }); },
            remove(_itemId, _amount, _options, callback) { callback?.(null, { revision: this.revision, rows: this.rows.length }); },
            patch(_operations, _options, callback) { callback?.(null, { revision: this.revision, rows: this.rows.length }); },
            move(_itemId, _options, callback) { callback?.(null, { revision: this.revision, rows: this.rows.length }); },
            adoptNative(_adoptionId, _options, callback) { callback?.(null, { revision: this.revision, rows: this.rows.length }); },
            use(_itemId, _options, callback) { callback?.(null, { revision: this.revision, rows: this.rows.length }); return 1; },
    };
    const player: Player = {
        id: 4,
        nickname: "Poppy",
        position: { x: 0, y: 0, z: 0 },
        emit() {},
        teleport: () => 0,
        inventory,
    };
    const repository: Repository = {
        async ensureContainer() { throw new Error("unused test repository method"); },
        async createNamedContainer() { throw new Error("unused test repository method"); },
        async getContainer() { return null; },
        async mutateContainer() { throw new Error("unused test repository method"); },
        async mutateContainers() { throw new Error("unused test repository method"); },
        async deleteContainer() { return false; },
        loadNative: async () => [{ itemId: "WoundCleaning", holder: "HealthPotionStorage", count: 2, kind: "item" }],
        saveNative: async (characterId: number, rows: HmpNativeInventoryRow[]) => { saved.push({ characterId, rows: clone(rows) }); return rows; },
    };
    const core = { characters: { active: () => ({ id: 9 }) } } as unknown as Core;
    const bridge = createNativeBridge({ repository, core, logger: { info: () => true, warn: () => true, error: () => true } });
    assert.strictEqual(await bridge.attach(player, { id: 9 }), true);
    assert.deepStrictEqual(calls, [
        ["persist", false],
        ["replace", [{ itemId: "WoundCleaning", holder: "HealthPotionStorage", count: 2, kind: "item" }]],
        ["waitForRevision", 2],
    ]);
    inventory.rows[0].count = 1;
    await bridge.onUpdated(player, inventory.rows);
    await bridge.flush();
    assert.deepStrictEqual(saved.at(-1), { characterId: 9, rows: [{ itemId: "WoundCleaning", holder: "HealthPotionStorage", count: 1, kind: "item" }] });
});

test("inventory UI opens through the public service without relying on flattened methods", async () => {
    const { service, transfers, repository, registry, native, player, core, events, config, clientEvents } = setup();
    const database = {
        ready: async () => true,
        migrate: async () => ({ applied: [] }),
    } as unknown as Database;
    const resource = createInventoryResource({
        database,
        repository,
        registry,
        inventory: service,
        transfers,
        native,
        core,
        events,
        config,
        migrations: [],
        logger: { info: () => true, warn: () => true, error: () => true },
        listPlayers: () => [player],
    });
    const view = await resource.ui.open(player);
    assert.strictEqual(view.characterId, 12);
    assert.strictEqual(resource.ui.isOpen(player), true);
    const opened = clientEvents.find((event) => event.name === "hmp-inventory:open");
    assert.ok(opened);
    assert.strictEqual(JSON.parse(String(opened.payload)).title, "Poppy Sweeting");
    await resource.onClientReady(player);
    const configured = clientEvents.find((event) => event.name === "hmp-inventory:configure");
    assert.deepStrictEqual(JSON.parse(String(configured?.payload)), {
        contract: "hmp.inventory.ui/v1",
        url: "fw://resources/hmp-inventory/dist/index.html",
    });
});
// Source-level TypeScript tests.
