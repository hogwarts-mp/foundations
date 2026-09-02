const { prettify } = require("./registry");
import type {
    HmpInventoryCustomRow,
    HmpInventoryItemOptions,
    HmpInventoryNativeViewRow,
    HmpInventoryUseTarget,
    HmpInventoryUseContext,
    HmpInventoryView,
    HmpNativeInventoryRow,
} from "../types";
import type {
    Character,
    Core,
    InventoryConfig,
    InventoryContainer,
    InventoryEvents,
    InventoryService,
    NativeBridge,
    Player,
    Registry,
    Repository,
} from "./internal";

function stableJson(value: unknown): string {
    if (!value || typeof value !== "object") return "{}";
    const sort = (entry: unknown): unknown => Array.isArray(entry)
        ? entry.map(sort)
        : entry && typeof entry === "object"
            ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, sort((entry as Record<string, unknown>)[key])]))
            : entry;
    return JSON.stringify(sort(value));
}

function inventoryError(code: string, message: string): Error & { code: string } {
    const error = new Error(message);
    return Object.assign(error, { code });
}

function createInventory(options: {
    repository: Repository;
    registry: Registry;
    native: NativeBridge;
    core: Core;
    events: InventoryEvents;
    config: InventoryConfig;
}): InventoryService {
    const { repository, registry, native, core, events, config } = options;
    const characterKey = (id: number) => `character:${Number(id)}`;

    function characterFor(target: Player | number): { character: Character; player: Player | null } {
        if (target && typeof target === "object") {
            const character = core.characters.active(target);
            if (!character) throw inventoryError("HMP_INVENTORY_NO_CHARACTER", "No character is active");
            return { character, player: target };
        }
        const id = Number(target);
        if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError("a player or character id is required");
        return { character: { id }, player: null };
    }

    async function ensureCharacter(character: Character): Promise<InventoryContainer> {
        return repository.ensureContainer({
            key: characterKey(character.id),
            characterId: character.id,
            label: "Inventory",
            slots: config.slots,
            maxWeight: config.maxWeight,
            metadata: { kind: "character" },
        });
    }

    const weightOf = (container: InventoryContainer) => container.items.reduce((total, row) => total + (registry.get(row.name)?.weight || 0) * row.amount, 0);

    function enrichCustom(row: import("./internal").InventoryItemRow): HmpInventoryCustomRow {
        const definition = registry.get(row.name);
        return {
            source: "custom",
            slot: row.slot,
            name: row.name,
            itemId: null,
            label: definition?.label || prettify(row.name) || "Unknown item",
            description: definition?.description || "This item definition is not currently registered.",
            icon: definition?.icon || "fw://resources/hmp-inventory/dist/icons/item.svg",
            category: definition?.category || "Unknown",
            kind: definition?.kind || "item",
            amount: row.amount,
            weight: (definition?.weight || 0) * row.amount,
            metadata: row.metadata || {},
            usable: definition?.usable === true,
        };
    }

    function enrichNative(row: HmpNativeInventoryRow): HmpInventoryNativeViewRow {
        const definition = registry.fromNative(row.itemId);
        const kind = definition?.kind || row.kind || "item";
        return {
            source: "native",
            slot: null,
            name: definition?.name || `native:${String(row.itemId).toLowerCase()}`,
            itemId: row.itemId,
            label: definition?.label || prettify(row.itemId) || row.itemId,
            description: definition?.description || "Held by Hogwarts Legacy's native inventory.",
            icon: definition?.icon || `fw://resources/hmp-inventory/dist/icons/${["gear", "tool", "mount"].includes(kind) ? kind : "item"}.svg`,
            category: definition?.category || row.itemType || row.holder || "Native",
            kind,
            holder: row.holder,
            amount: row.count,
            weight: 0,
            variation: row.variation || "",
            identified: row.identified === true,
            equipped: row.equipped === true,
            metadata: {},
            usable: definition?.usable === true,
        };
    }

    async function get(target: Player | number): Promise<HmpInventoryView> {
        const { character, player } = characterFor(target);
        const container = await ensureCharacter(character);
        const custom = [...container.items].sort((left, right) => left.slot - right.slot).map(enrichCustom);
        const nativeRows = player ? native.list(player).map(enrichNative) : [];
        const items = [...custom, ...nativeRows];
        return {
            characterId: Number(character.id),
            container: { key: container.key, label: container.label, slots: container.slots, maxWeight: container.maxWeight },
            usedSlots: items.length,
            weight: items.reduce((total, row) => total + row.weight, 0),
            custom,
            native: nativeRows,
            items,
        };
    }

    async function add(target: Player | number, name: string, amount = 1, itemOptions: HmpInventoryItemOptions = {}): Promise<number> {
        const definition = registry.get(name);
        if (!definition) throw inventoryError("HMP_INVENTORY_ITEM_UNKNOWN", `Unknown item '${name}'`);
        const quantity = Math.trunc(Number(amount));
        if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new TypeError("amount must be a positive integer");
        const { character, player } = characterFor(target);
        if (definition.native) {
            if (!player) throw inventoryError("HMP_INVENTORY_NATIVE_OFFLINE", "Native items require an online player");
            await native.give(player, definition, quantity, itemOptions);
            await events.emit("hmp:inventory:changed", { player, character, action: "add", item: definition, amount: quantity, source: "native" });
            return quantity;
        }
        const metadata = itemOptions.metadata && typeof itemOptions.metadata === "object" ? itemOptions.metadata : {};
        await ensureCharacter(character);
        const mutation = await repository.mutateContainer(characterKey(character.id), (container) => {
            let left = quantity;
            const metadataKey = stableJson(metadata);
            if (!definition.unique) {
                for (const row of container.items) {
                    if (row.name !== definition.name || stableJson(row.metadata) !== metadataKey || row.amount >= definition.maxStack) continue;
                    const moved = Math.min(left, definition.maxStack - row.amount);
                    row.amount += moved;
                    left -= moved;
                    if (!left) break;
                }
            }
            while (left > 0) {
                const occupied = new Set(container.items.map((row) => row.slot));
                let slot = 1;
                while (occupied.has(slot) && slot <= container.slots) slot++;
                if (slot > container.slots) throw inventoryError("HMP_INVENTORY_FULL", "There are not enough inventory slots");
                const moved = definition.unique ? 1 : Math.min(left, definition.maxStack);
                container.items.push({ slot, name: definition.name, amount: moved, metadata: { ...metadata } });
                left -= moved;
            }
            const weight = weightOf(container);
            if (container.maxWeight > 0 && weight > container.maxWeight + Number.EPSILON) throw inventoryError("HMP_INVENTORY_OVERWEIGHT", "The inventory cannot carry that much weight");
            return quantity;
        });
        await events.emit("hmp:inventory:changed", { player, character, action: "add", item: definition, amount: quantity, source: "custom", container: mutation.container });
        return quantity;
    }

    async function remove(target: Player | number, name: string, amount = 1, itemOptions: HmpInventoryItemOptions = {}): Promise<number> {
        const definition = registry.get(name);
        if (!definition) throw inventoryError("HMP_INVENTORY_ITEM_UNKNOWN", `Unknown item '${name}'`);
        const quantity = Math.trunc(Number(amount));
        if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new TypeError("amount must be a positive integer");
        const { character, player } = characterFor(target);
        if (definition.native) {
            if (!player) throw inventoryError("HMP_INVENTORY_NATIVE_OFFLINE", "Native items require an online player");
            await native.remove(player, definition, quantity, itemOptions);
            await events.emit("hmp:inventory:changed", { player, character, action: "remove", item: definition, amount: quantity, source: "native" });
            return quantity;
        }
        await ensureCharacter(character);
        const wantedMetadata = itemOptions.metadata && typeof itemOptions.metadata === "object" ? stableJson(itemOptions.metadata) : null;
        const mutation = await repository.mutateContainer(characterKey(character.id), (container) => {
            const available = container.items.reduce((total, row) => total + (row.name === definition.name && (wantedMetadata === null || stableJson(row.metadata) === wantedMetadata) ? row.amount : 0), 0);
            if (available < quantity) throw inventoryError("HMP_INVENTORY_NOT_ENOUGH", `Not enough ${definition.label}`);
            let left = quantity;
            for (const row of [...container.items].sort((a, b) => b.slot - a.slot)) {
                if (row.name !== definition.name || (wantedMetadata !== null && stableJson(row.metadata) !== wantedMetadata)) continue;
                const moved = Math.min(left, row.amount);
                row.amount -= moved;
                left -= moved;
                if (row.amount <= 0) container.items.splice(container.items.indexOf(row), 1);
                if (!left) break;
            }
            return quantity;
        });
        await events.emit("hmp:inventory:changed", { player, character, action: "remove", item: definition, amount: quantity, source: "custom", container: mutation.container });
        return quantity;
    }

    async function count(target: Player | number, name: string, itemOptions: HmpInventoryItemOptions = {}): Promise<number> {
        const definition = registry.get(name);
        if (!definition) return 0;
        const { character, player } = characterFor(target);
        if (definition.native) {
            if (!player) return 0;
            const variation = itemOptions.variation === undefined ? null : String(itemOptions.variation);
            return native.list(player).reduce((total, row) => total + (row.itemId === definition.nativeId && (variation === null || (row.variation || "") === variation) ? row.count : 0), 0);
        }
        const container = await ensureCharacter(character);
        const wantedMetadata = itemOptions.metadata && typeof itemOptions.metadata === "object" ? stableJson(itemOptions.metadata) : null;
        return container.items.reduce((total, row) => total + (row.name === definition.name && (wantedMetadata === null || stableJson(row.metadata) === wantedMetadata) ? row.amount : 0), 0);
    }

    async function move(target: Player | number, fromSlot: number, toSlot: number): Promise<boolean> {
        const { character, player } = characterFor(target);
        const from = Math.trunc(Number(fromSlot));
        const to = Math.trunc(Number(toSlot));
        await ensureCharacter(character);
        const mutation = await repository.mutateContainer(characterKey(character.id), (container) => {
            if (from < 1 || from > container.slots || to < 1 || to > container.slots) throw new RangeError("slot is outside this inventory");
            const source = container.items.find((row) => row.slot === from);
            if (!source) throw inventoryError("HMP_INVENTORY_SLOT_EMPTY", "The source slot is empty");
            const destination = container.items.find((row) => row.slot === to);
            if (!destination) source.slot = to;
            else { destination.slot = from; source.slot = to; }
            return true;
        });
        await events.emit("hmp:inventory:changed", { player, character, action: "move", source: "custom", container: mutation.container });
        return true;
    }

    async function use(player: Player, target: number | HmpInventoryUseTarget): Promise<boolean> {
        const { character } = characterFor(player);
        if (target && typeof target === "object" && target.source === "native") {
            const itemId = String(target.itemId || "").trim();
            const definition = registry.fromNative(itemId);
            if (!definition?.native || !definition.usable) throw inventoryError("HMP_INVENTORY_NOT_USABLE", "That native item cannot be used");
            const context = {
                player,
                character,
                item: definition,
                itemId: definition.nativeId,
                variation: String(target.variation || ""),
                source: "native" as const,
                cancelled: false,
            };
            await events.emit("hmp:inventory:using", context);
            if (context.cancelled) return false;
            await native.use(player, definition, { variation: context.variation });
            await events.emit("hmp:inventory:used", context);
            return true;
        }
        const slot = typeof target === "number" ? target : target?.slot;
        const container = await ensureCharacter(character);
        const row = container.items.find((item) => item.slot === Math.trunc(Number(slot)));
        if (!row) throw inventoryError("HMP_INVENTORY_SLOT_EMPTY", "That slot is empty");
        const definition = registry.get(row.name);
        if (!definition?.usable) throw inventoryError("HMP_INVENTORY_NOT_USABLE", "That item cannot be used");
        const context: HmpInventoryUseContext<Player> = {
            player,
            character: character as HmpInventoryUseContext<Player>["character"],
            item: definition,
            slot: row.slot,
            metadata: { ...row.metadata },
            cancelled: false,
            consume: definition.consumable,
        };
        if (definition.use) await definition.use(context);
        await events.emit("hmp:inventory:using", context);
        if (context.cancelled) return false;
        if (context.consume) await remove(player, definition.name, 1, { metadata: row.metadata });
        await events.emit("hmp:inventory:used", context);
        return true;
    }

    const api = Object.freeze({
        get,
        add,
        remove,
        count,
        has: async (target: Player | number, name: string, amount = 1, opts?: HmpInventoryItemOptions) => (await count(target, name, opts)) >= amount,
        move,
        use,
    });
    return { api, ensureCharacter, enrichNative, characterKey };
}

export = { createInventory, stableJson };
// TypeScript source.
