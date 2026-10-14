export interface HmpBeastPlayer {
    id: number;
    nickname: string;
    sendChat?(message: string): void;
}

export type HmpBeastGender = "male" | "female";

/** A beast kept in a character's bag. */
export interface HmpStoredBeast {
    /** Stable id within the character's bag; the game's own bag entry ids change every connection. */
    uid: string;
    /** The game's species id, e.g. "Hippogriff" (Beast.catalog() lists them). */
    species: string;
    /** One of the species' colours; empty until the game rolls one for a beast given without. */
    color: string;
    gender: HmpBeastGender;
    /** Custom name, or empty for the species' own. */
    name: string;
    /** Epoch milliseconds. */
    caughtAt: number;
}

export interface HmpBeastInit {
    species: string;
    /** Omit to roll on the game's own spawn weights. */
    color?: string;
    gender?: HmpBeastGender;
    name?: string;
}

export interface HmpBeastContext<P = HmpBeastPlayer> {
    resource?: string;
    actor?: P;
    reason?: string;
}

export interface HmpBeastPosition {
    x: number;
    y: number;
    z: number;
}

/** A player's bag, by the player (their current character) or a character id. */
export interface HmpBeastBagApi<P = HmpBeastPlayer> {
    list(target: P | number): Promise<HmpStoredBeast[]>;
    /** Adds a beast; it reaches the player's game too while that character is loaded. */
    give(target: P | number, beast: HmpBeastInit, context?: HmpBeastContext<P>): Promise<HmpStoredBeast>;
    /** Removes a beast by uid, from the player's game too; false when the bag holds no such beast. */
    take(target: P | number, uid: string, context?: HmpBeastContext<P>): Promise<boolean>;
    /**
     * Lets a beast go in front of the player, as a Field Guide release does: it leaves the bag and, with
     * `release.respawn` on, comes back into the world there. Null when the bag holds no such beast.
     */
    release(player: P, uid: string, context?: HmpBeastContext<P>): Promise<HmpBeastReleaseResult | null>;
    /** Renames a beast; an empty name restores the species' own. Null when the bag holds no such beast. */
    rename(target: P | number, uid: string, name: string, context?: HmpBeastContext<P>): Promise<HmpStoredBeast | null>;
}

export interface HmpBeastReleaseResult {
    beast: HmpStoredBeast;
    /** The world beast it came back as, or null when release.respawn is off or the respawn failed. */
    respawnedBeastId: number | null;
}

export interface HmpBeastMenuApi<P = HmpBeastPlayer> {
    /** Opens the player's beast list (an hmp-ui menu); resolves when they close it. */
    open(player: P): Promise<void>;
}

export interface HmpBeastsStatus {
    state: "starting" | "ready" | "degraded" | "stopped";
    lastError: string;
    /** Characters whose bags are loaded into a player's game. */
    loadedBags: number;
    uptimeMs: number;
}

export interface HmpBeastsServer<P = HmpBeastPlayer> {
    bag: HmpBeastBagApi<P>;
    menu: HmpBeastMenuApi<P>;
    status(): HmpBeastsStatus;
}

/** `hmp:beasts:captured`: a player's catch was kept in their character's bag. */
export interface HmpBeastCapturedEvent<P = HmpBeastPlayer> {
    player: P;
    characterId: number;
    beast: HmpStoredBeast;
}

/** `hmp:beasts:released`: a beast left a player's bag through the Field Guide or `bag.release`. */
export interface HmpBeastReleasedEvent<P = HmpBeastPlayer> {
    player: P;
    source: "fieldGuide" | "api";
    characterId: number;
    beast: HmpStoredBeast;
    at: HmpBeastPosition;
    /** The world beast it came back as, or null when release.respawn is off or the respawn failed. */
    respawnedBeastId: number | null;
}
