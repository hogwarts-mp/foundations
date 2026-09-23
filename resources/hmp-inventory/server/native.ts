import type { HmpInventoryItemOptions, HmpItemDefinition, HmpNativeInventoryRow } from "../types";
import type { Character, Core, Logger, NativeBridge, Player, Repository } from "./internal";

interface NativeRowInternal extends HmpNativeInventoryRow { unique?: boolean }
type NativeMethod = "replace" | "give" | "remove" | "use";

function sanitizeRows(raw: unknown): NativeRowInternal[] {
    const rows: NativeRowInternal[] = [];
    for (const row of Array.isArray(raw) ? raw : []) {
        if (!row || typeof row !== "object") continue;
        const value = row as Record<string, unknown>;
        const itemId = String(value.itemId || "").trim().slice(0, 96);
        const holder = String(value.holder || "").trim().slice(0, 64);
        const count = Math.trunc(Number(value.count));
        if (!itemId || !holder || !Number.isSafeInteger(count) || count <= 0) continue;
        const normalized: NativeRowInternal = { itemId, holder, count };
        if (value.variation !== undefined && value.variation !== null && String(value.variation)) normalized.variation = String(value.variation).slice(0, 96);
        if (value.identified === true) normalized.identified = true;
        if (value.equipped === true) normalized.equipped = true;
        if (value.hoodUp === true) normalized.hoodUp = true;
        if (["item", "gear", "tool", "mount"].includes(String(value.kind))) normalized.kind = value.kind as NativeRowInternal["kind"];
        if (value.itemType) normalized.itemType = String(value.itemType).slice(0, 64);
        if (value.unique === true) normalized.unique = true;
        rows.push(normalized);
    }
    return rows;
}

function callbackCall(player: Player, method: NativeMethod, ...args: unknown[]): Promise<HogwartsMpNativeInventoryResult> {
    return new Promise<HogwartsMpNativeInventoryResult>((resolve, reject) => {
        if (!player?.inventory || typeof player.inventory[method] !== "function") {
            const error = new Error(`native inventory method '${method}' is unavailable`);
            Object.assign(error, { code: "HMP_INVENTORY_NATIVE_UNAVAILABLE" });
            reject(error);
            return;
        }
        let settled = false;
        const done = (error: HogwartsMpInventoryOperationError | null, result: HogwartsMpNativeInventoryResult | null) => {
            if (settled) return;
            settled = true;
            if (error) {
                const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
                reject(error instanceof Error ? error : Object.assign(new Error(message), typeof error === "object" ? error : {}));
            }
            else if (result) resolve(result);
            else reject(Object.assign(new Error(`native inventory method '${method}' returned no result`), { code: "HMP_INVENTORY_NATIVE_INVALID_RESULT" }));
        };
        try {
            const nativeMethod = player.inventory[method] as unknown as (...callArgs: unknown[]) => unknown;
            const returned = nativeMethod.call(player.inventory, ...args, done);
            if (returned && typeof returned === "object" && "then" in returned && typeof returned.then === "function") {
                Promise.resolve(returned).then((result) => resolve(result as unknown as HogwartsMpNativeInventoryResult), reject);
            }
        } catch (error) { reject(error); }
    });
}

async function waitForApplied(player: Player, result: HogwartsMpNativeInventoryResult): Promise<HogwartsMpNativeInventoryState> {
    const revision = Number(result?.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) {
        throw Object.assign(new Error("native inventory mutation returned an invalid revision"), { code: "HMP_INVENTORY_NATIVE_INVALID_REVISION" });
    }
    const inventory = player?.inventory;
    if (!inventory || typeof inventory.waitForRevision !== "function") {
        throw Object.assign(new Error("native inventory revision acknowledgement is unavailable"), { code: "HMP_INVENTORY_NATIVE_UNAVAILABLE" });
    }
    return inventory.waitForRevision(revision);
}

function createNativeBridge(options: { repository: Repository; core: Core; logger: Logger }): NativeBridge {
    const { repository, core, logger } = options;
    const active = new Map<number, number>();
    const loading = new Set<number>();
    const writes = new Map<number, Promise<HmpNativeInventoryRow[]>>();

    function list(player: Player): HmpNativeInventoryRow[] {
        try { return sanitizeRows(player?.inventory?.list?.() || []); }
        catch (_) { return []; }
    }

    function queueSave(characterId: number, rows: unknown): Promise<HmpNativeInventoryRow[]> {
        const previous = writes.get(characterId) || Promise.resolve();
        const next = previous.catch(() => {}).then(() => repository.saveNative(characterId, sanitizeRows(rows)));
        writes.set(characterId, next);
        next.then(
            () => { if (writes.get(characterId) === next) writes.delete(characterId); },
            () => { if (writes.get(characterId) === next) writes.delete(characterId); },
        );
        return next;
    }

    async function attach(player: Player, character: Character): Promise<boolean> {
        if (!player || !character) return false;
        loading.add(player.id);
        try {
            const rows = sanitizeRows(await repository.loadNative(character.id));
            const replaced = await callbackCall(player, "replace", rows);
            await waitForApplied(player, replaced);
            active.set(player.id, Number(character.id));
            return true;
        } finally { loading.delete(player.id); }
    }

    async function save(player: Player, character?: Character | null): Promise<boolean> {
        const characterId = Number(character?.id ?? active.get(player?.id));
        if (!player || !Number.isSafeInteger(characterId) || characterId <= 0) return false;
        if (player.inventory?.revision === 0) return false;
        await queueSave(characterId, list(player));
        return true;
    }

    async function onUpdated(player: Player, rows: unknown): Promise<boolean> {
        if (!player || loading.has(player.id)) return false;
        const characterId = active.get(player.id) ?? core.characters.active(player)?.id;
        if (!characterId) return false;
        await queueSave(Number(characterId), rows);
        return true;
    }

    function detach(player?: Player | null): boolean {
        if (!player) return false;
        loading.delete(player.id);
        return active.delete(player.id);
    }

    async function give(player: Player, definition: HmpItemDefinition<Player> | null, amount: number, options: HmpInventoryItemOptions = {}): Promise<number> {
        if (!definition?.nativeId) throw new TypeError("a native-backed item definition is required");
        const nativeOptions: HogwartsMpNativeItemOptions = {};
        if (options.variation) nativeOptions.variation = String(options.variation).slice(0, 96);
        if (options.identified === true) nativeOptions.identified = true;
        if (definition.unique) nativeOptions.unique = true;
        const result = await callbackCall(player, "give", definition.nativeId, amount, nativeOptions);
        await waitForApplied(player, result);
        return amount;
    }

    async function remove(player: Player, definition: HmpItemDefinition<Player> | null, amount: number, options: HmpInventoryItemOptions = {}): Promise<number> {
        if (!definition?.nativeId) throw new TypeError("a native-backed item definition is required");
        const nativeOptions: HogwartsMpNativeItemOptions = {};
        if (options.variation) nativeOptions.variation = String(options.variation).slice(0, 96);
        const result = await callbackCall(player, "remove", definition.nativeId, amount, nativeOptions);
        await waitForApplied(player, result);
        return amount;
    }

    async function use(player: Player, definition: HmpItemDefinition<Player> | null, options: Pick<HmpInventoryItemOptions, "variation"> = {}): Promise<boolean> {
        if (!definition?.nativeId) throw new TypeError("a native-backed item definition is required");
        const nativeOptions: Pick<HogwartsMpNativeItemOptions, "variation"> = {};
        if (options.variation) nativeOptions.variation = String(options.variation).slice(0, 96);
        const result = await callbackCall(player, "use", definition.nativeId, nativeOptions);
        await waitForApplied(player, result);
        return true;
    }

    async function flush(): Promise<void> {
        await Promise.allSettled([...writes.values()]);
    }

    return Object.freeze({ list, attach, save, onUpdated, detach, give, remove, use, flush, sanitizeRows, status: () => ({ active: active.size, pendingWrites: writes.size }) });
}

export = { createNativeBridge, sanitizeRows };
// TypeScript source.
