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

/** Every family of gate the host's `Gates` builtin drives; only a portcullis has a lock. */
export type HmpDoorGateKind = "portcullis" | "runeGate" | "swingGate" | "crawlGrate";

export interface HmpDoorRule {
    priority: number;
    /** `deny` withholds an unlock, leaving the game's own state; `lock` actively locks and beats both. */
    action: "allow" | "deny" | "lock";
    /**
     * Actor names, or full asset paths when an entry holds `/` or `:`. A name is an `FName`, unique only
     * within its Outer, so a repeated one matches every placement carrying it — prefer a path to target one.
     */
    doors?: "*" | ReadonlyArray<string>;
    /** Gate actor names, or path names when an entry holds `/` or `:`. A gate is never a door, nor a door a gate. */
    gates?: "*" | ReadonlyArray<string>;
    /** On a `gates: "*"` rule: only gates of these kinds. */
    kind?: ReadonlyArray<HmpDoorGateKind>;
    /** On an `allow` targeting gates: open them, keeping a portcullis raised, rather than only unlock them. */
    open?: true;
    locks?: ReadonlyArray<string>;
    alohomora?: true;
    /**
     * On a `deny` or `lock` rule naming doors: the Alohomora level their padlocks ask for. The server holds it
     * for every player, so a rule carrying it has no `match`. Needs a HogwartsMP host with `Doors.set` `lockLevel`.
     */
    lockLevel?: 1 | 2 | 3;
    match?: HmpDoorMatch;
}

export interface HmpResolvedDoorPolicy {
    unlockAll: boolean;
    unlockDoors: string[];
    unlockAllExcept: string[];
    lockDoors: string[];
    unlockLocks: string[];
    superAlohomora: boolean;
    /** Every gate of these kinds outside `gateAllExcept` is unlocked, or opened. */
    unlockGateKinds: HmpDoorGateKind[];
    openGateKinds: HmpDoorGateKind[];
    unlockGates: string[];
    openGates: string[];
    gateAllExcept: string[];
    lockGates: string[];
    /** Takes every portcullis off its clock, which each client runs on its own. */
    freezeGateSchedule: boolean;
}

/** Gate state the server holds for every player; an axis left out is not held. */
export interface HmpDoorHeldGate {
    locked?: boolean;
    open?: boolean;
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
    // null when the player has no hmp-core session yet; hmp:session:ready syncs them.
    sync(player: P): Promise<HmpResolvedDoorPolicy | null>;
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
