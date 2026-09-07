import type { HmpBreakableState, HmpNativeBreakableInfo as NativeBreakableInfo, HmpNativeBreakables as NativeBreakables } from "../types";

interface ClientDependencies {
    breakables?: NativeBreakables | null;
    events: { emitServer(eventName: string, payload?: unknown): void };
    notify?(message: string): void;
    log?(message: string): void;
    warn?(message: string): void;
}

interface ClientStatus {
    state: "ready" | "stopped";
    systems: string[];
    entries: number;
    breakablesArmed: boolean;
    reported: number;
}

const BREAKABLES = "breakables";
const STATES: ReadonlySet<string> = new Set(["broken", "repaired"]);

function parsePayload(raw: unknown): Record<string, unknown> {
    if (typeof raw === "string") {
        try { return JSON.parse(raw) as Record<string, unknown>; }
        catch (_) { return {}; }
    }
    return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
}

function isUid(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0xffffffff;
}

function createWorldStateClient(dependencies: ClientDependencies) {
    const store = new Map<string, Map<string, string>>();
    const log = dependencies.log || (() => undefined);
    const warn = dependencies.warn || log;
    let stopped = false;
    let armed = false;
    let reported = 0;

    function bucket(system: string): Map<string, string> {
        let entries = store.get(system);
        if (!entries) {
            entries = new Map();
            store.set(system, entries);
        }
        return entries;
    }

    function breakableStates(entries: Map<string, string>): Array<{ uid: number; state: HmpBreakableState }> {
        const out: Array<{ uid: number; state: HmpBreakableState }> = [];
        for (const [key, value] of entries) {
            const uid = Number(key);
            if (isUid(uid) && STATES.has(value)) out.push({ uid, state: value as HmpBreakableState });
        }
        return out;
    }

    function start(): void {
        const native = dependencies.breakables;
        if (native) {
            try { armed = native.arm(); }
            catch (error) { warn(`Breakables.arm failed: ${error instanceof Error ? error.message : String(error)}`); }
        }
        else warn("Breakables builtin is missing; this client build predates repairable-object sync");
        dependencies.events.emitServer("hmp-worldstate:ready", "{}");
    }

    /** Full snapshot from the server: replaces the cache and snaps repairables into place. */
    function sync(raw: unknown): boolean {
        if (stopped) return false;
        const payload = parsePayload(raw);
        const systems = payload.systems;
        if (!systems || typeof systems !== "object") return false;
        store.clear();
        for (const [system, rows] of Object.entries(systems as Record<string, unknown>)) {
            if (!Array.isArray(rows)) continue;
            const entries = bucket(system);
            for (const row of rows) {
                if (Array.isArray(row) && typeof row[0] === "string" && typeof row[1] === "string") entries.set(row[0], row[1]);
            }
        }
        const native = dependencies.breakables;
        if (native) {
            native.clear();
            const states = breakableStates(bucket(BREAKABLES));
            const applied = native.applyStates(states, true);
            log(`sync: ${states.length} repairable state(s), ${applied} applied to loaded objects`);
        }
        return true;
    }

    function change(raw: unknown): boolean {
        if (stopped) return false;
        const payload = parsePayload(raw);
        const { system, key, value } = payload;
        if (typeof system !== "string" || typeof key !== "string") return false;
        const entries = bucket(system);
        if (value === null || value === undefined) entries.delete(key);
        else if (typeof value === "string") entries.set(key, value);
        else return false;
        if (system === BREAKABLES) {
            const native = dependencies.breakables;
            const uid = Number(key);
            if (native && isUid(uid) && typeof value === "string" && STATES.has(value)) {
                const ok = native.setState(uid, value as HmpBreakableState, false);
                log(`change: object ${uid} -> ${value} (${ok ? "applied" : "not loaded"})`);
            }
        }
        return true;
    }

    function clear(raw: unknown): boolean {
        if (stopped) return false;
        const { system } = parsePayload(raw);
        if (typeof system !== "string") return false;
        store.delete(system);
        if (system === BREAKABLES) {
            dependencies.breakables?.clear();
            dependencies.notify?.("[worldstate] repairable-object state cleared; objects reset on next stream-in");
        }
        return true;
    }

    /** The native watch saw the LOCAL player repair or break a repairable object. */
    function report(uid: unknown, state: unknown, cls: unknown): boolean {
        if (stopped || !isUid(uid) || typeof state !== "string" || !STATES.has(state)) return false;
        reported += 1;
        dependencies.events.emitServer("hmp-worldstate:breakable", JSON.stringify({ uid, state, cls: typeof cls === "string" ? cls : "" }));
        return true;
    }

    function nearby(radius?: number): NativeBreakableInfo[] {
        const native = dependencies.breakables;
        if (!native) return [];
        const rows = native.list(Math.max(0, Math.min(50000, Number(radius) || 3000)));
        log(`${rows.length} repairable(s) within range (dist | uid | state | class):`);
        for (const row of rows) {
            const state = row.repairing ? "repairing" : row.broken ? "broken" : "intact";
            log(`  ${row.dist.toFixed(0).padStart(6)}cm  ${String(row.uid).padStart(10)}  ${state.padEnd(9)}  ${row.cls}`);
        }
        dependencies.notify?.(`[worldstate] ${rows.length} repairable(s) nearby; see the console`);
        return rows;
    }

    function diagnostic(raw: unknown): boolean {
        const payload = parsePayload(raw);
        if (payload.action === "nearby") { nearby(typeof payload.radius === "number" ? payload.radius : undefined); return true; }
        return false;
    }

    const state = Object.freeze({
        get: (system: string, key: string): string | null => store.get(system)?.get(key) ?? null,
        list: (system: string): Array<{ key: string; value: string }> => [...(store.get(system) || new Map<string, string>())].map(([key, value]) => ({ key, value })),
        systems: (): string[] => [...store.keys()].sort(),
    });

    return Object.freeze({
        start,
        sync,
        change,
        clear,
        report,
        diagnostic,
        nearby,
        state,
        breakables: Object.freeze({
            list: (): Array<{ uid: number; state: HmpBreakableState }> => breakableStates(bucket(BREAKABLES)),
            nearby,
        }),
        status: (): ClientStatus => ({
            state: stopped ? "stopped" : "ready",
            systems: state.systems(),
            entries: [...store.values()].reduce((sum, entries) => sum + entries.size, 0),
            breakablesArmed: armed,
            reported,
        }),
        stop: () => { stopped = true; store.clear(); },
    });
}

export = { createWorldStateClient, parsePayload, isUid };
