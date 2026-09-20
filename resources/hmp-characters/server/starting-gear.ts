import type { CharacterEventPayload, Inventory, StartingGearEntry } from "./internal";

function inventoryError(value: HogwartsMpInventoryOperationError | unknown): Error {
    if (value instanceof Error) return value;
    const message = value && typeof value === "object" && "message" in value ? String(value.message) : String(value);
    return Object.assign(new Error(message), value && typeof value === "object" ? value : {});
}

function patchStartingGear(payload: CharacterEventPayload, entries: StartingGearEntry[]): Promise<boolean> {
    if (!entries.length) return Promise.resolve(false);
    const inventory = payload?.session?.player?.inventory;
    if (!inventory || typeof inventory.patch !== "function" || typeof inventory.waitForRevision !== "function") {
        return Promise.reject(Object.assign(new Error("native inventory patching is unavailable"), { code: "HMP_CHARACTERS_INVENTORY_UNAVAILABLE" }));
    }
    const operations: HogwartsMpInventoryPatchOperation[] = entries.map((entry) => ({ ...entry, op: "give" as const }));
    return new Promise<HogwartsMpNativeInventoryResult>((resolve, reject) => {
        let settled = false;
        const done: HogwartsMpNativeInventoryCallback = (error, result) => {
            if (settled) return;
            settled = true;
            if (error) reject(inventoryError(error));
            else if (result) resolve(result);
            else reject(Object.assign(new Error("native inventory patch returned no result"), { code: "HMP_CHARACTERS_INVENTORY_INVALID_RESULT" }));
        };
        try { inventory.patch(operations, {}, done); }
        catch (error) { settled = true; reject(error); }
    }).then(async (result) => {
        await inventory.waitForRevision(result.revision);
        return true;
    });
}

function createStartingGearGrant(entries: StartingGearEntry[], native: Pick<Inventory["native"], "save">) {
    const configured = entries.map((entry) => ({ ...entry }));
    const pending = new Set<number>();

    function created(payload: CharacterEventPayload): boolean {
        const characterId = Number(payload?.character?.id);
        if (!configured.length || !Number.isSafeInteger(characterId) || characterId <= 0) return false;
        pending.add(characterId);
        return true;
    }

    async function loaded(payload: CharacterEventPayload): Promise<boolean> {
        const characterId = Number(payload?.character?.id);
        if (!pending.has(characterId)) return false;
        await patchStartingGear(payload, configured);
        if (!await native.save(payload.session.player, payload.character)) {
            throw Object.assign(new Error("starting gear inventory snapshot was not saved"), { code: "HMP_CHARACTERS_INVENTORY_SAVE_FAILED" });
        }
        pending.delete(characterId);
        return true;
    }

    function deleted(payload: CharacterEventPayload): boolean {
        return pending.delete(Number(payload?.character?.id));
    }

    return Object.freeze({ created, loaded, deleted, pending: (characterId: number) => pending.has(Number(characterId)) });
}

export = { createStartingGearGrant, patchStartingGear };
