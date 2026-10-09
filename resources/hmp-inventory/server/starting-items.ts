import errorsModule = require("./errors");
import type { CharacterPayload, InventoryService, Logger, StartingItemEntry } from "./internal";

const { messageOf } = errorsModule;

interface StartingItemsDeps {
    inventory: InventoryService;
    ready: () => Promise<unknown>;
    logger: Logger;
}

function createStartingItemsGrant(entries: StartingItemEntry[], deps: StartingItemsDeps) {
    const configured = entries.map((entry) => ({ ...entry }));
    const pending = new Set<number>();

    function created(payload: CharacterPayload): boolean {
        const characterId = Number(payload?.character?.id);
        if (!configured.length || !Number.isSafeInteger(characterId) || characterId <= 0) return false;
        pending.add(characterId);
        return true;
    }

    async function loaded(payload: CharacterPayload): Promise<boolean> {
        const characterId = Number(payload?.character?.id);
        if (!pending.has(characterId)) return false;
        const player = payload?.session?.player;
        if (!player) return false;
        await deps.ready();
        // Past this point the container exists and the native bridge is attached, so a
        // per-item failure is logged and skipped rather than retried on the next login
        // (which would duplicate every item granted before the failing one).
        pending.delete(characterId);
        for (const entry of configured) {
            try {
                await deps.inventory.api.add(player, entry.name, entry.amount, {
                    identified: true,
                    ...(entry.metadata ? { metadata: entry.metadata } : {}),
                });
            } catch (error: unknown) {
                deps.logger.warn(`Could not grant starting item '${entry.name}' to character #${characterId}: ${messageOf(error)}`);
            }
        }
        return true;
    }

    function deleted(payload: CharacterPayload): boolean {
        return pending.delete(Number(payload?.character?.id));
    }

    return Object.freeze({ created, loaded, deleted, pending: (characterId: number) => pending.has(Number(characterId)) });
}

export = { createStartingItemsGrant };
