import { getCatalogEntry, hasCatalogEntry, listCatalogEntries } from "../shared/catalog";
import type { HmpNpcSnapshot, HmpNpcSpawnInput, HmpNpcStatus, HmpNpcs } from "../types";
import type { NativeNpc, NpcsServiceOptions } from "./internal";

interface ManagedNpc { resource: string; npc: NativeNpc }

interface NpcsService extends HmpNpcs {
    died(id: number): boolean;
    stop(): void;
}

function resourceName(value: unknown): string {
    if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)) {
        throw new TypeError("NPC resource must be a non-empty resource name up to 64 characters");
    }
    return value;
}

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
        throw new TypeError(`${label} must be a number from ${minimum} to ${maximum}`);
    }
    return parsed;
}

function integer(value: unknown, label: string, minimum: number): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new TypeError(`${label} must be an integer of at least ${minimum}`);
    return parsed;
}

function snapshot(entry: ManagedNpc): HmpNpcSnapshot {
    const npc = entry.npc;
    return {
        id: npc.id,
        enemyId: npc.enemyId,
        resource: entry.resource,
        disposition: npc.disposition,
        ownerId: npc.ownerId,
        alive: npc.alive,
        health: npc.health,
        maxHealth: npc.maxHealth,
        scale: npc.scale,
    };
}

export function createNpcsService(options: NpcsServiceOptions): NpcsService {
    const { config, native } = options;
    const managed = new Map<number, ManagedNpc>();
    let state: "ready" | "stopped" = "ready";

    function ensureReady(): void {
        if (state === "stopped") throw new Error("hmp-npcs is stopped");
    }

    function count(resource: string): number {
        let total = 0;
        for (const entry of managed.values()) if (entry.resource === resource) total += 1;
        return total;
    }

    function destroy(id: number, resource: string): boolean {
        ensureReady();
        const owner = resourceName(resource);
        const key = integer(id, "NPC id", 0);
        const entry = managed.get(key);
        if (!entry || entry.resource !== owner) return false;
        managed.delete(key);
        try { entry.npc.destroy(); } catch { /* Native actor may already be gone. */ }
        return true;
    }

    function clear(resource: string): number {
        ensureReady();
        const owner = resourceName(resource);
        const ids = [...managed].filter(([, entry]) => entry.resource === owner).map(([id]) => id);
        for (const id of ids) destroy(id, owner);
        return ids.length;
    }

    const catalog = Object.freeze({ get: getCatalogEntry, has: hasCatalogEntry, list: listCatalogEntries });

    return Object.freeze({
        catalog,
        spawn(input: HmpNpcSpawnInput): HmpNpcSnapshot {
            ensureReady();
            if (!input || typeof input !== "object") throw new TypeError("NPC spawn input must be an object");
            const resource = resourceName(input.resource);
            if (typeof input.enemyId !== "string" || !hasCatalogEntry(input.enemyId)) {
                throw new TypeError(`Unknown Framework enemy id '${String(input.enemyId)}'`);
            }
            if (managed.size >= config.maximumManagedNpcs) throw new Error("hmp-npcs managed NPC limit reached");
            if (count(resource) >= config.maximumPerResource) throw new Error(`hmp-npcs limit reached for '${resource}'`);
            if (!input.position || typeof input.position !== "object") throw new TypeError("NPC position must be an object");
            const x = finite(input.position.x, "NPC position.x", -10_000_000, 10_000_000);
            const y = finite(input.position.y, "NPC position.y", -10_000_000, 10_000_000);
            const z = finite(input.position.z, "NPC position.z", -10_000_000, 10_000_000);
            const disposition = input.disposition || "hostile";
            if (!(["hostile", "friendly"] as const).includes(disposition)) throw new TypeError("NPC disposition is invalid");
            const ownerId = input.ownerId === undefined ? undefined : integer(input.ownerId, "NPC ownerId", 0);
            const maxHealth = input.maxHealth === undefined ? undefined : finite(input.maxHealth, "NPC maxHealth", 1, 100_000_000);
            const scale = input.scale === undefined ? undefined : finite(input.scale, "NPC scale", 0.05, 100);
            const npc = native.create(input.enemyId, x, y, z, disposition, ownerId);
            if (!npc) throw new Error(`Framework could not spawn '${input.enemyId}'`);
            if (managed.has(npc.id)) {
                try { npc.destroy(); } catch { /* Best effort rollback. */ }
                throw new Error(`Framework returned duplicate NPC id ${npc.id}`);
            }
            try {
                if (maxHealth !== undefined) { npc.setMaxHealth(maxHealth); npc.setHealth(maxHealth); }
                if (scale !== undefined) npc.setScale(scale);
            } catch (error) {
                try { npc.destroy(); } catch { /* Best effort rollback. */ }
                throw error;
            }
            const entry = { resource, npc };
            managed.set(npc.id, entry);
            return snapshot(entry);
        },
        destroy,
        clear,
        get(id: number) {
            ensureReady();
            const entry = managed.get(integer(id, "NPC id", 0));
            return entry ? snapshot(entry) : null;
        },
        list(resource?: string) {
            ensureReady();
            const owner = resource === undefined ? undefined : resourceName(resource);
            return [...managed.values()].filter((entry) => !owner || entry.resource === owner).map(snapshot);
        },
        status(): HmpNpcStatus {
            const resources: Record<string, number> = {};
            for (const entry of managed.values()) resources[entry.resource] = (resources[entry.resource] || 0) + 1;
            return {
                state,
                managed: managed.size,
                resources,
                catalogSize: listCatalogEntries().length,
                maximumManagedNpcs: config.maximumManagedNpcs,
                maximumPerResource: config.maximumPerResource,
            };
        },
        died(id: number) { return managed.delete(id); },
        stop() {
            if (state === "stopped") return;
            for (const entry of managed.values()) {
                try { entry.npc.destroy(); } catch { /* Best effort shutdown. */ }
            }
            managed.clear();
            state = "stopped";
        },
    });
}
