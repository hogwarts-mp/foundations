import type {
    HmpWorldStateChange, HmpWorldStateEntry, HmpWorldStatePlayer, HmpWorldStateStatus, HmpWorldStateSystemOptions, HmpWorldStateWriteOptions,
} from "../types";
import type { ChangePayload, SyncPayload, WorldStateDependencies, WorldStateService } from "./internal";

const SYSTEM_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const KEY_MAX = 64;
const VALUE_MAX = 256;
const DEFAULT_MAX_ENTRIES = 100000;

interface SystemRecord {
    options: HmpWorldStateSystemOptions;
    entries: Map<string, HmpWorldStateEntry>;
    subscribers: Set<(change: HmpWorldStateChange) => void>;
}

function cleanKey(key: unknown): string {
    const value = String(key ?? "").trim();
    if (!value || value.length > KEY_MAX) throw new TypeError(`key must be 1-${KEY_MAX} characters`);
    return value;
}

function cleanValue(value: unknown): string {
    if (typeof value !== "string") throw new TypeError("value must be a string");
    if (value.length > VALUE_MAX) throw new TypeError(`value must be at most ${VALUE_MAX} characters`);
    return value;
}

function createWorldStateService<P extends HmpWorldStatePlayer>(dependencies: WorldStateDependencies<P>): WorldStateService<P> {
    const { repository, migrations, core } = dependencies;
    const now = dependencies.now || Date.now;
    const logger = dependencies.logger;
    const startedAt = now();
    const systems = new Map<string, SystemRecord>();
    // Rows for systems that register after the load; handed over on registration so nothing is lost.
    const orphans = new Map<string, Map<string, HmpWorldStateEntry>>();
    const synced = new Set<number>();
    let state: HmpWorldStateStatus["state"] = "starting";
    let lastError = "";
    let readyPromise: Promise<void> | null = null;

    function system(name: string): SystemRecord {
        const record = systems.get(name);
        if (!record) throw new Error(`unknown world-state system '${name}'`);
        return record;
    }

    function actorAccount(options?: HmpWorldStateWriteOptions<P>): number | null {
        const actor = options?.actor;
        if (!actor) return null;
        try { return core.accounts.getByPlayer(actor)?.id ?? null; }
        catch (_) { return null; }
    }

    function publish(name: string, record: SystemRecord, change: HmpWorldStateChange): void {
        for (const handler of record.subscribers) {
            try { handler(change); }
            catch (error) { logger?.warn(`world-state subscriber for '${name}' failed: ${error instanceof Error ? error.message : String(error)}`); }
        }
        if (record.options.broadcast === false) return;
        const payload: ChangePayload = { system: name, key: change.key, value: change.deleted ? null : change.value, by: change.updatedByAccountId };
        const raw = JSON.stringify(payload);
        for (const player of dependencies.players()) player.emit("hmp-worldstate:change", raw);
    }

    function snapshot(): SyncPayload {
        const out: SyncPayload = { systems: {} };
        for (const [name, record] of systems) out.systems[name] = [...record.entries.values()].map((entry) => [entry.key, entry.value] as [string, string]);
        return out;
    }

    async function ready(): Promise<void> {
        if (!readyPromise) {
            readyPromise = (async () => {
                await repository.start(migrations);
                for (const row of await repository.loadAll()) {
                    const entry: HmpWorldStateEntry = { system: row.system, key: row.key, value: row.value, updatedByAccountId: row.updatedByAccountId, updatedAt: row.updatedAt };
                    const record = systems.get(row.system);
                    if (record) record.entries.set(row.key, entry);
                    else {
                        const bucket = orphans.get(row.system) || new Map<string, HmpWorldStateEntry>();
                        bucket.set(row.key, entry);
                        orphans.set(row.system, bucket);
                    }
                }
                state = "ready";
                lastError = "";
            })().catch((error) => {
                state = "degraded";
                lastError = error instanceof Error ? error.message : String(error);
                readyPromise = null;
                throw error;
            });
        }
        return readyPromise;
    }

    function assertWritable(): void {
        if (state === "stopped") throw new Error("hmp-worldstate is stopped");
        if (state !== "ready") throw new Error(`hmp-worldstate is ${state}${lastError ? `: ${lastError}` : ""}`);
    }

    const stateApi = Object.freeze({
        get(name: string, key: string): string | null {
            return systems.get(name)?.entries.get(cleanKey(key))?.value ?? null;
        },
        list(name: string): HmpWorldStateEntry[] {
            const record = systems.get(name);
            return record ? [...record.entries.values()].map((entry) => ({ ...entry })) : [];
        },
        async set(name: string, rawKey: string, rawValue: string, options?: HmpWorldStateWriteOptions<P>): Promise<boolean> {
            assertWritable();
            const record = system(name);
            const key = cleanKey(rawKey);
            const value = cleanValue(rawValue);
            const keyVerdict = record.options.validateKey?.(key) ?? true;
            if (keyVerdict !== true) throw new TypeError(keyVerdict);
            const valueVerdict = record.options.validateValue?.(key, value) ?? true;
            if (valueVerdict !== true) throw new TypeError(valueVerdict);
            const existing = record.entries.get(key);
            if (existing && existing.value === value) return false;
            if (!existing && record.entries.size >= (record.options.maxEntries ?? DEFAULT_MAX_ENTRIES)) throw new Error(`world-state system '${name}' is full`);
            const by = actorAccount(options);
            await repository.put(name, key, value, by);
            const entry: HmpWorldStateEntry = { system: name, key, value, updatedByAccountId: by, updatedAt: new Date(now()) };
            record.entries.set(key, entry);
            publish(name, record, { ...entry, previous: existing ? existing.value : null, deleted: false });
            return true;
        },
        async delete(name: string, rawKey: string, options?: HmpWorldStateWriteOptions<P>): Promise<boolean> {
            assertWritable();
            const record = system(name);
            const key = cleanKey(rawKey);
            const existing = record.entries.get(key);
            if (!existing) return false;
            await repository.remove(name, key);
            record.entries.delete(key);
            publish(name, record, { ...existing, updatedByAccountId: actorAccount(options), updatedAt: new Date(now()), previous: existing.value, deleted: true });
            return true;
        },
        async clear(name: string, options?: HmpWorldStateWriteOptions<P>): Promise<number> {
            assertWritable();
            const record = system(name);
            if (!record.entries.size) return 0;
            const removed = [...record.entries.values()];
            await repository.clear(name);
            record.entries.clear();
            const by = actorAccount(options);
            for (const entry of removed) {
                for (const handler of record.subscribers) {
                    try { handler({ ...entry, updatedByAccountId: by, updatedAt: new Date(now()), previous: entry.value, deleted: true }); }
                    catch (_) { /* a subscriber's failure must not block the clear */ }
                }
            }
            if (record.options.broadcast !== false) {
                const raw = JSON.stringify({ system: name });
                for (const player of dependencies.players()) player.emit("hmp-worldstate:clear", raw);
            }
            return removed.length;
        },
        subscribe(name: string, handler: (change: HmpWorldStateChange) => void): () => boolean {
            const record = system(name);
            record.subscribers.add(handler);
            return () => record.subscribers.delete(handler);
        },
        sync(player: P): number {
            const payload = snapshot();
            player.emit("hmp-worldstate:sync", JSON.stringify(payload));
            synced.add(Number(player.id));
            return Object.values(payload.systems).reduce((sum, rows) => sum + rows.length, 0);
        },
        syncAll(): number {
            const players = dependencies.players();
            for (const player of players) stateApi.sync(player);
            return players.length;
        },
    });

    const systemsApi = Object.freeze({
        register(name: string, options: HmpWorldStateSystemOptions = {}): () => boolean {
            if (!SYSTEM_PATTERN.test(name)) throw new TypeError("system name must be lowercase letters, digits, '_' or '-', up to 32 characters, starting with a letter");
            if (systems.has(name)) throw new Error(`world-state system '${name}' is already registered`);
            const entries = orphans.get(name) || new Map<string, HmpWorldStateEntry>();
            orphans.delete(name);
            systems.set(name, { options: { ...options }, entries, subscribers: new Set() });
            return () => systemsApi.unregister(name);
        },
        unregister(name: string): boolean {
            const record = systems.get(name);
            if (!record) return false;
            systems.delete(name);
            if (record.entries.size) orphans.set(name, record.entries);
            return true;
        },
        list: () => [...systems.keys()].sort(),
        has: (name: string) => systems.has(name),
    });

    const service: WorldStateService<P> = {
        state: stateApi,
        systems: systemsApi,
        breakables: undefined as never, // attached by breakables.ts before the service is exported
        status: () => ({
            state,
            systems: systemsApi.list(),
            entries: [...systems.values()].reduce((sum, record) => sum + record.entries.size, 0),
            syncedPlayers: synced.size,
            uptimeMs: now() - startedAt,
            lastError,
        }),
        ready,
        stop: () => { state = "stopped"; synced.clear(); },
    };
    return service;
}

export = { createWorldStateService, cleanKey, cleanValue, SYSTEM_PATTERN, KEY_MAX, VALUE_MAX };
