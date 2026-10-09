export interface HmpLootPlayer {
    id: number;
    nickname: string;
    sendChat?(message: string): void;
}

export type HmpLootKind = "chest" | "moonstone" | "foragable";

/** "character": every character may take it once per respawn. "shared": the first taker empties it for everyone. */
export type HmpLootScope = "character" | "shared";

export interface HmpLootItem {
    itemId: string;
    count: number;
}

export interface HmpLootVector {
    x: number;
    y: number;
    z: number;
}

export interface HmpLootDefinition {
    /** Stable name; takes are recorded against it, so renaming one forgets who looted it. */
    key: string;
    kind: HmpLootKind;
    position: HmpLootVector;
    yaw: number;
    items: HmpLootItem[];
    scope: HmpLootScope;
    /** Seconds until a take expires and the loot is back; null never respawns. */
    respawnSeconds: number | null;
    /** Blueprint class path; the kind's default when left out. */
    model?: string;
}

export interface HmpLootState extends HmpLootDefinition {
    /** The Lootables id this server session placed it under; 0 before the resource is ready. */
    lootableId: number;
    /** Shared scope: when the current take expires (epoch ms), or null when it is not taken or never respawns. */
    respawnAt: number | null;
    /** Shared scope: whether it is taken right now. */
    taken: boolean;
}

export interface HmpLootRecord {
    key: string;
    /** Null for a shared take. */
    characterId: number | null;
    accountId: number | null;
    takenAt: number;
    respawnAt: number | null;
}

export interface HmpLootTake<P = HmpLootPlayer> extends HmpLootRecord {
    player: P;
    items: HmpLootItem[];
}

export interface HmpLootFamilies {
    chests: boolean;
    moonstones: boolean;
    foragables: boolean;
}

export interface HmpLootStatus {
    state: "starting" | "ready" | "degraded" | "stopped";
    lastError: string;
    lootables: number;
    records: number;
    /** Families of the game's own loot this resource switched off. */
    suppressedGameLoot: HmpLootFamilies;
    uptimeMs: number;
}

export interface HmpLootServer<P = HmpLootPlayer> {
    lootables: {
        list(): HmpLootState[];
        get(key: string): HmpLootState | null;
        /** The take in effect for one character (or the shared take with characterId null), until the sweep releases it. */
        record(key: string, characterId: number | null): HmpLootRecord | null;
        /** Ends takes now: one character's, or with characterId left out every take of the lootable. */
        reset(key: string, characterId?: number | null): Promise<number>;
        onTaken(handler: (take: HmpLootTake<P>) => void): () => void;
    };
    status(): HmpLootStatus;
}
