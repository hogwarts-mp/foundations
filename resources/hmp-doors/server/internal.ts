import type { HmpCore, HmpCoreGroup } from "../../hmp-core/types";
import type { HmpLogger } from "../../hmp-lib/types";
import type { HmpDoorPlayer, HmpDoorRule, HmpDoorsServer } from "../types";

/** The host's server-held door state, as far as this resource uses it. */
export interface NativeServerDoors {
    /** An axis left out stays as it is and null releases it. A host older than `lockLevel` ignores that axis. */
    set(selector: string, state: { lockLevel?: 1 | 2 | 3 | null }): boolean;
    /** `lockLevel` is absent on a host older than it. */
    get(selector: string): { lockLevel?: 1 | 2 | 3 | null } | null;
}

export interface DoorConfig {
    command: string;
    enableCommands: boolean;
    adminGroups: Array<{ key: string; minimumGrade?: number }>;
    rules: HmpDoorRule[];
}

export interface DoorDependencies<P extends HmpDoorPlayer> {
    core: HmpCore<P>;
    config: DoorConfig;
    players(): P[];
    now?: () => number;
    /** Absent where the host has no server `Doors` builtin. */
    doors?: NativeServerDoors;
    logger?: Pick<HmpLogger, "warn">;
}

export interface DoorService<P extends HmpDoorPlayer> extends HmpDoorsServer<P> {
    stop(): void;
}

export type EffectiveGroups = ReadonlyArray<Pick<HmpCoreGroup, "key" | "grade">>;
