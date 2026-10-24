import type { HmpNpcDisposition, HmpNpcIdle, HmpNpcMoveOptions, HmpNpcMovementState, HmpNpcVector3, HmpNpcWaypoint } from "../types";

export interface NpcsConfig {
    maximumManagedNpcs: number;
    maximumPerResource: number;
}

export interface NativeNpc {
    readonly id: number;
    readonly enemyId: string;
    readonly disposition: HmpNpcDisposition;
    readonly alive: boolean;
    readonly ownerId?: number;
    readonly scale: number;
    readonly health: number;
    readonly maxHealth: number;
    setScale(scale: number): void;
    setMaxHealth(health: number): void;
    setHealth(health: number): void;
    destroy(): void;
    /** An older host takes the world alone and ignores `map`. */
    setVirtualWorld?(world: number, map?: string): void;
    // Movement: absent on a host before NPC paths.
    moveAlong?(waypoints: HmpNpcWaypoint[], options?: HmpNpcMoveOptions): boolean;
    moveTo?(x: number, y: number, z: number, options?: HmpNpcMoveOptions): boolean;
    stop?(): void;
    pause?(): void;
    resume?(): void;
    readonly movement?: HmpNpcMovementState;
    readonly waypoints?: HmpNpcWaypoint[];
    idle?: HmpNpcIdle;
    home?: HmpNpcVector3 | null;
}

export interface NativeNpcs {
    create(
        enemyId: string,
        x: number,
        y: number,
        z: number,
        disposition?: HmpNpcDisposition,
        preferredOwnerId?: number,
    ): NativeNpc | undefined;
}

export interface NpcsServiceOptions {
    config: NpcsConfig;
    native: NativeNpcs;
    /** Raises the `hmp:npcs:*` events other resources listen for. */
    emit?(eventName: string, payload: unknown): void;
    now?: () => number;
}
