import type { HmpCore, HmpCoreGroup } from "../../hmp-core/types";
import type { HmpLogger } from "../../hmp-lib/types";
import type { HmpDoorHeldGate, HmpDoorPlayer, HmpDoorRule, HmpDoorsServer } from "../types";

/** The host's server-held door state, as far as this resource uses it. */
export interface NativeServerDoors {
    /** An axis left out stays as it is and null releases it. A host older than `lockLevel` ignores that axis. */
    set(selector: string, state: { lockLevel?: 1 | 2 | 3 | null }): boolean;
    /** `lockLevel` is absent on a host older than it. */
    get(selector: string): { lockLevel?: 1 | 2 | 3 | null } | null;
    /** Whether a lock a player opens by key or Alohomora is held unlocked for everyone. Absent on an older host. */
    setShareUnlocks?(share: boolean): void;
    getShareUnlocks?(): boolean;
}

/** Gate state the host's server `Gates` builtin holds for one selector. */
export interface NativeGateState {
    selector: string;
    kind: "name" | "path";
    locked: boolean | null;
    open: boolean | null;
}

/** The host's server-held gate state; absent on a host older than it. */
export interface NativeServerGates {
    /** An axis left out stays as it is and null releases it; a selector left holding nothing is released. */
    set(selector: string, state: { locked?: boolean | null; open?: boolean | null }): boolean;
    get(selector: string): NativeGateState | null;
    list(): NativeGateState[];
}

export interface DoorConfig {
    command: string;
    enableCommands: boolean;
    adminGroups: Array<{ key: string; minimumGrade?: number }>;
    /** false keeps a key or Alohomora unlock in the opener's game; true lets the host hold it unlocked for all. */
    shareUnlocks: boolean;
    /** "freeze" takes every portcullis off its clock; "local" leaves each client's own schedule moving them. */
    gateSchedule: "local" | "freeze";
    /** Gate state the server holds for every player while the resource runs, by selector. */
    heldGates: Record<string, HmpDoorHeldGate>;
    rules: HmpDoorRule[];
}

export interface DoorDependencies<P extends HmpDoorPlayer> {
    core: HmpCore<P>;
    config: DoorConfig;
    players(): P[];
    now?: () => number;
    /** Absent where the host has no server `Doors` builtin. */
    doors?: NativeServerDoors;
    gates?: NativeServerGates;
    logger?: Pick<HmpLogger, "warn">;
}

export interface DoorService<P extends HmpDoorPlayer> extends HmpDoorsServer<P> {
    stop(): void;
}

export type EffectiveGroups = ReadonlyArray<Pick<HmpCoreGroup, "key" | "grade">>;
