import type { HmpBreakableEntry, HmpBreakableState, HmpBreakablesApi, HmpWorldStatePlayer, HmpWorldStateWriteOptions } from "../types";
import type { WorldStateService } from "./internal";

/**
 * The repairable-object system: key = the game's own object uid (CRC-32 of the placed location, so
 * every client agrees), value = broken | repaired. Reports come from the native `Breakables` watch.
 */
const SYSTEM = "breakables";
const STATES: ReadonlySet<string> = new Set(["broken", "repaired"]);

function isUid(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0xffffffff;
}

function validateKey(key: string): true | string {
    return /^[1-9][0-9]{0,9}$/.test(key) && isUid(Number(key)) ? true : "breakable key must be a uint32 object uid";
}

function validateValue(_key: string, value: string): true | string {
    return STATES.has(value) ? true : "breakable state must be 'broken' or 'repaired'";
}

/** Shape of a client report; null when it is not one. */
function parseReport(raw: unknown): { uid: number; state: HmpBreakableState; cls: string } | null {
    let data: unknown = raw;
    if (typeof raw === "string") {
        try { data = JSON.parse(raw); }
        catch (_) { return null; }
    }
    if (!data || typeof data !== "object") return null;
    const { uid, state, cls } = data as Record<string, unknown>;
    if (!isUid(uid) || typeof state !== "string" || !STATES.has(state)) return null;
    return { uid, state: state as HmpBreakableState, cls: typeof cls === "string" ? cls.slice(0, 96) : "" };
}

function attach<P extends HmpWorldStatePlayer>(service: WorldStateService<P>): HmpBreakablesApi<P> {
    service.systems.register(SYSTEM, { validateKey, validateValue });
    const api: HmpBreakablesApi<P> = Object.freeze({
        get(uid: number): HmpBreakableState | null {
            if (!isUid(uid)) return null;
            const value = service.state.get(SYSTEM, String(uid));
            return value && STATES.has(value) ? value as HmpBreakableState : null;
        },
        list(): HmpBreakableEntry[] {
            return service.state.list(SYSTEM)
                .filter((entry) => STATES.has(entry.value))
                .map((entry) => ({ uid: Number(entry.key), state: entry.value as HmpBreakableState, updatedByAccountId: entry.updatedByAccountId, updatedAt: entry.updatedAt }));
        },
        set(uid: number, state: HmpBreakableState, options?: HmpWorldStateWriteOptions<P>): Promise<boolean> {
            if (!isUid(uid)) return Promise.reject(new TypeError("uid must be a uint32 object id"));
            return service.state.set(SYSTEM, String(uid), state, options);
        },
        clear: (options?: HmpWorldStateWriteOptions<P>) => service.state.clear(SYSTEM, options),
    });
    (service as { breakables: HmpBreakablesApi<P> }).breakables = api;
    return api;
}

export = { attach, parseReport, validateKey, validateValue, isUid, SYSTEM };
