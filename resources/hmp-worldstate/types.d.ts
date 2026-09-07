export interface HmpWorldStatePlayer {
    id: number;
    nickname: string;
    connected?: boolean;
    emit(eventName: string, payload?: unknown): void;
    sendChat?(message: string): void;
}

export interface HmpWorldStateEntry {
    system: string;
    key: string;
    value: string;
    updatedByAccountId: number | null;
    updatedAt: string | Date | null;
}

export interface HmpWorldStateChange extends HmpWorldStateEntry {
    /** The value before this change, or null when the key was created. */
    previous: string | null;
    /** Null when the key was deleted. */
    value: string;
    deleted: boolean;
}

export interface HmpWorldStateWriteOptions<P = HmpWorldStatePlayer> {
    /** The player responsible, recorded as the account behind the write. */
    actor?: P | null;
}

export interface HmpWorldStateSystemOptions {
    /** Return true to accept, or a string to reject with that message. Keys are 1–64 characters. */
    validateKey?(key: string): true | string;
    /** Return true to accept, or a string to reject with that message. Values are 0–256 characters. */
    validateValue?(key: string, value: string): true | string;
    /** Cap on stored keys for the system; a write beyond it is rejected. Default 100000. */
    maxEntries?: number;
    /** Push writes to every client as they happen. Default true. */
    broadcast?: boolean;
}

export interface HmpWorldStateSystemsApi {
    register(name: string, options?: HmpWorldStateSystemOptions): () => boolean;
    unregister(name: string): boolean;
    list(): string[];
    has(name: string): boolean;
}

export interface HmpWorldStateApi<P = HmpWorldStatePlayer> {
    /** Cached read; null when the key is absent. */
    get(system: string, key: string): string | null;
    list(system: string): HmpWorldStateEntry[];
    /** Resolves false when the value did not change. Rejects for an unknown system or a refused key/value. */
    set(system: string, key: string, value: string, options?: HmpWorldStateWriteOptions<P>): Promise<boolean>;
    delete(system: string, key: string, options?: HmpWorldStateWriteOptions<P>): Promise<boolean>;
    /** Removes every key of a system; resolves how many were removed. */
    clear(system: string, options?: HmpWorldStateWriteOptions<P>): Promise<number>;
    subscribe(system: string, handler: (change: HmpWorldStateChange) => void): () => boolean;
    /** Pushes the whole store to one client; returns how many entries were sent. */
    sync(player: P): number;
    syncAll(): number;
}

export type HmpBreakableState = "broken" | "repaired";

export interface HmpBreakableEntry {
    uid: number;
    state: HmpBreakableState;
    updatedByAccountId: number | null;
    updatedAt: string | Date | null;
}

export interface HmpBreakablesApi<P = HmpWorldStatePlayer> {
    get(uid: number): HmpBreakableState | null;
    list(): HmpBreakableEntry[];
    set(uid: number, state: HmpBreakableState, options?: HmpWorldStateWriteOptions<P>): Promise<boolean>;
    clear(options?: HmpWorldStateWriteOptions<P>): Promise<number>;
}

export interface HmpWorldStateStatus {
    state: "starting" | "ready" | "degraded" | "stopped";
    systems: string[];
    entries: number;
    syncedPlayers: number;
    uptimeMs: number;
    lastError: string;
}

export interface HmpWorldStateServer<P = HmpWorldStatePlayer> {
    state: HmpWorldStateApi<P>;
    systems: HmpWorldStateSystemsApi;
    breakables: HmpBreakablesApi<P>;
    status(): HmpWorldStateStatus;
}

export interface HmpNativeBreakableInfo {
    uid: number;
    cls: string;
    name: string;
    broken: boolean;
    repairing: boolean;
    dist: number;
    x?: number;
    y?: number;
    z?: number;
}

/** The mod's `Breakables` builtin (client builds from the breakables change onward). */
export interface HmpNativeBreakables {
    arm(): boolean;
    isInstalled(): boolean;
    list(radius?: number): HmpNativeBreakableInfo[];
    setState(uid: number, state: HmpBreakableState, instant?: boolean): boolean;
    applyStates(states: Array<{ uid: number; state: HmpBreakableState }>, instant?: boolean): number;
    clear(): void;
    rescan(): number;
}
