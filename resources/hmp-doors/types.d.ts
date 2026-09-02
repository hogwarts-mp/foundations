import type { HmpCoreCharacter, HmpCoreGroup } from "../hmp-core/types";

export interface HmpDoorPlayer {
    id: number;
    nickname: string;
    connected?: boolean;
    emit(eventName: string, payload?: unknown): void;
    sendChat?(message: string): void;
}

export interface HmpDoorGroupRequirement {
    key: string;
    minimumGrade?: number;
}

export interface HmpDoorMatch {
    groups: ReadonlyArray<HmpDoorGroupRequirement>;
    groupMode?: "any" | "all";
}

export interface HmpDoorRule {
    priority: number;
    /** `deny` withholds an unlock, leaving the game's own state; `lock` actively locks and beats both. */
    action: "allow" | "deny" | "lock";
    /**
     * Actor names, or full asset paths when an entry holds `/` or `:`. A name is an `FName`, unique only
     * within its Outer, so a repeated one matches every placement carrying it — prefer a path to target one.
     */
    doors?: "*" | ReadonlyArray<string>;
    locks?: ReadonlyArray<string>;
    alohomora?: true;
    match?: HmpDoorMatch;
}

export interface HmpResolvedDoorPolicy {
    unlockAll: boolean;
    unlockDoors: string[];
    unlockAllExcept: string[];
    lockDoors: string[];
    unlockLocks: string[];
    superAlohomora: boolean;
}

export interface HmpDoorResolution<P = HmpDoorPlayer> {
    player: P;
    character: HmpCoreCharacter | null;
    groups: HmpCoreGroup[];
    grants: string[];
    policy: HmpResolvedDoorPolicy;
}

export interface HmpDoorPolicyApi<P = HmpDoorPlayer> {
    resolve(player: P): Promise<HmpDoorResolution<P>>;
    sync(player: P): Promise<HmpResolvedDoorPolicy>;
    syncAll(): Promise<number>;
}

export interface HmpDoorGrantsApi<P = HmpDoorPlayer> {
    list(player: P): Promise<string[]>;
    grant(player: P, doorName: string): Promise<boolean>;
    revoke(player: P, doorName: string): Promise<boolean>;
    clear(player: P): Promise<number>;
}

export interface HmpDoorsStatus {
    state: "ready" | "stopped";
    rules: number;
    syncedPlayers: number;
    uptimeMs: number;
}

export interface HmpDoorsServer<P = HmpDoorPlayer> {
    policy: HmpDoorPolicyApi<P>;
    grants: HmpDoorGrantsApi<P>;
    status(): HmpDoorsStatus;
}
