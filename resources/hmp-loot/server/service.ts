import type { HmpLootDefinition, HmpLootFamilies, HmpLootItem, HmpLootPlayer, HmpLootRecord, HmpLootState, HmpLootStatus, HmpLootTake } from "../types";
import type { LootDependencies, LootService } from "./internal";

const NONE: HmpLootFamilies = Object.freeze({ chests: false, moonstones: false, foragables: false });

const recordId = (key: string, characterId: number | null): string => `${key}\u0000${characterId ?? 0}`;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

function createLootService<P extends HmpLootPlayer>(dependencies: LootDependencies<P>): LootService<P> {
    const { config, lootables, world, repository, migrations, core } = dependencies;
    const now = dependencies.now || Date.now;
    const schedule = dependencies.schedule || ((fn: () => void, ms: number) => {
        const timer = setInterval(fn, ms);
        return () => clearInterval(timer);
    });
    const logger = dependencies.logger;
    const startedAt = now();
    const definitions = new Map(config.lootables.map((definition) => [definition.key, definition]));
    const ids = new Map<string, number>();
    const keysById = new Map<number, string>();
    const records = new Map<string, HmpLootRecord>();
    const subscribers = new Set<(take: HmpLootTake<P>) => void>();
    let state: HmpLootStatus["state"] = "starting";
    let lastError = "";
    let readyPromise: Promise<void> | null = null;
    let stopSweep: (() => void) | null = null;
    let suppressed: HmpLootFamilies = { ...NONE };

    // Only for rows read at startup: a loaded take stays in effect until the sweep releases it.
    const live = (record: HmpLootRecord | undefined): boolean => !!record && (record.respawnAt === null || record.respawnAt > now());

    function characterOf(player: P): number | null {
        try { return core.characters.active(player)?.id ?? null; }
        catch (_) { return null; }
    }

    function accountOf(player: P): number | null {
        try { return core.accounts.getByPlayer(player)?.id ?? null; }
        catch (_) { return null; }
    }

    // Without a character there is nobody to record a take against, so nothing is offered.
    function viewFor(definition: HmpLootDefinition, characterId: number | null): { items?: HmpLootItem[]; locked?: boolean } | null {
        if (characterId === null) return { locked: true };
        return records.has(recordId(definition.key, characterId)) ? { items: [] } : null;
    }

    function sync(player: P): void {
        if (state !== "ready") return;
        const characterId = characterOf(player);
        for (const definition of definitions.values()) {
            const id = ids.get(definition.key);
            if (definition.scope === "character" && id) lootables.setView(id, player, viewFor(definition, characterId));
        }
    }

    function playerWith(characterId: number): P | null {
        return dependencies.players().find((player) => characterOf(player) === characterId) ?? null;
    }

    // The take is over: the loot is back for whoever it was taken from.
    function release(record: HmpLootRecord): void {
        records.delete(recordId(record.key, record.characterId));
        const definition = definitions.get(record.key);
        const id = ids.get(record.key);
        if (!definition || !id || state !== "ready") return;
        if (record.characterId === null) {
            lootables.setItems(id, definition.items);
            return;
        }
        const player = playerWith(record.characterId);
        if (player) lootables.setView(id, player, null);
    }

    async function forget(record: HmpLootRecord): Promise<void> {
        release(record);
        try { await repository.remove(record.key, record.characterId); }
        catch (error) { logger?.warn(`Could not delete the take of '${record.key}' by character ${record.characterId ?? "shared"}: ${messageOf(error)}`); }
    }

    async function sweep(): Promise<void> {
        const due = [...records.values()].filter((record) => record.respawnAt !== null && record.respawnAt <= now());
        for (const record of due) await forget(record);
    }

    function place(definition: HmpLootDefinition): void {
        const sharedTaken = definition.scope === "shared" && records.has(recordId(definition.key, null));
        try {
            const id = lootables.place(definition.kind, definition.position.x, definition.position.y, definition.position.z, definition.yaw, {
                items: sharedTaken ? [] : definition.items,
                mode: definition.scope === "character" ? "perPlayer" : "shared",
                ...(definition.model ? { model: definition.model } : {}),
            });
            if (!id) throw new Error("Lootables.place returned 0");
            ids.set(definition.key, id);
            keysById.set(id, definition.key);
        }
        catch (error) {
            logger?.warn(`Could not place lootable '${definition.key}': ${messageOf(error)}`);
        }
    }

    async function ready(): Promise<void> {
        if (!readyPromise) {
            readyPromise = (async () => {
                try {
                    await repository.start(migrations);
                    for (const record of await repository.loadAll()) {
                        // A take of a lootable no longer configured stays in the table, so re-adding it remembers.
                        if (!definitions.has(record.key)) continue;
                        if (live(record)) records.set(recordId(record.key, record.characterId), record);
                        else await repository.remove(record.key, record.characterId);
                    }
                    if (Object.values(config.suppressGameLoot).some(Boolean)) {
                        if (!world.suppressLoot(config.suppressGameLoot)) throw new Error("World.suppressLoot refused the configured families");
                        suppressed = { ...config.suppressGameLoot };
                    }
                    for (const definition of definitions.values()) place(definition);
                    state = "ready";
                    stopSweep = schedule(() => { void sweep(); }, config.sweepMs);
                    for (const player of dependencies.players()) sync(player);
                }
                catch (error) {
                    state = "degraded";
                    lastError = messageOf(error);
                    throw error;
                }
            })();
        }
        return readyPromise;
    }

    // The builtin has already emptied the contents (shared) or the taker's view (character); the record
    // keeps a character's view empty across character switches, reconnects and restarts.
    async function taken(player: P, lootableId: number, items: HmpLootItem[]): Promise<void> {
        const key = keysById.get(lootableId);
        const definition = key ? definitions.get(key) : undefined;
        if (!key || !definition || state !== "ready") return;
        const characterId = definition.scope === "character" ? characterOf(player) : null;
        if (definition.scope === "character" && characterId === null) {
            logger?.warn(`#${player.id} took from '${key}' without a character; nothing was recorded`);
            return;
        }
        const takenAt = now();
        const record: HmpLootRecord = { key, characterId, accountId: accountOf(player), takenAt, respawnAt: definition.respawnSeconds === null ? null : takenAt + definition.respawnSeconds * 1000 };
        records.set(recordId(key, characterId), record);
        for (const handler of subscribers) {
            try { handler({ ...record, player, items }); }
            catch (error) { logger?.warn(`An hmp-loot take subscriber failed: ${messageOf(error)}`); }
        }
        await repository.put(record);
    }

    function stateOf(definition: HmpLootDefinition): HmpLootState {
        const shared = definition.scope === "shared" ? records.get(recordId(definition.key, null)) : undefined;
        return { ...definition, items: definition.items.map((item) => ({ ...item })), lootableId: ids.get(definition.key) ?? 0, taken: !!shared, respawnAt: shared ? shared.respawnAt : null };
    }

    function stop(): void {
        stopSweep?.();
        stopSweep = null;
        for (const id of ids.values()) {
            try { lootables.remove(id); }
            catch (_) { /* the server is going down with it */ }
        }
        ids.clear();
        keysById.clear();
        const lifted = Object.fromEntries(Object.entries(suppressed).filter(([, on]) => on).map(([family]) => [family, false]));
        if (Object.keys(lifted).length) world.suppressLoot(lifted);
        suppressed = { ...NONE };
        state = "stopped";
    }

    const api = Object.freeze({
        list: () => [...definitions.values()].map(stateOf),
        get: (key: string) => {
            const definition = definitions.get(key);
            return definition ? stateOf(definition) : null;
        },
        record: (key: string, characterId: number | null) => {
            const record = records.get(recordId(key, characterId));
            return record ? { ...record } : null;
        },
        async reset(key: string, characterId?: number | null) {
            if (!definitions.has(key)) throw new Error(`unknown lootable '${key}'`);
            const matches = [...records.values()].filter((record) => record.key === key && (characterId === undefined || record.characterId === (characterId ?? null)));
            for (const record of matches) await forget(record);
            return matches.length;
        },
        onTaken(handler: (take: HmpLootTake<P>) => void) {
            subscribers.add(handler);
            return () => subscribers.delete(handler);
        },
    });

    return Object.freeze({
        lootables: api,
        status: (): HmpLootStatus => ({ state, lastError, lootables: ids.size, records: records.size, suppressedGameLoot: { ...suppressed }, uptimeMs: now() - startedAt }),
        ready,
        taken,
        sync,
        stop,
    });
}

export = { createLootService };
