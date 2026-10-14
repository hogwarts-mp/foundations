import type { HmpCore } from "../../hmp-core/types";
import type { HmpLogger } from "../../hmp-lib/types";
import type { HmpMySQL, HmpMySQLMigration } from "../../hmp-mysql/types";
import type { HmpBeastGender, HmpBeastPlayer, HmpBeastsServer, HmpBeastPosition, HmpStoredBeast } from "../types";

export interface BeastsConfig {
    /** The chat command that opens the beast menu, without the slash. */
    command: string;
    enableCommands: boolean;
    release: {
        /** Bring a beast released from the Field Guide back into the world where its player stood. */
        respawn: boolean;
        /** Whether a respawned beast may be caught again straight away. */
        capturable: boolean;
    };
}

/** A bag entry as the host's Beast builtin reports it; its id is only good for this connection. */
export interface NativeCapturedBeast {
    id: number;
    species: string;
    color: string;
    gender: HmpBeastGender;
    name: string;
}

export interface NativeBeastHandle {
    readonly id: number;
    capturable: boolean;
}

/** The host's server-side Beast builtin, as far as this resource uses it. */
export interface NativeBeasts<P> {
    bagOf(player: P): NativeCapturedBeast[];
    giveCaptured(player: P, beast: { species: string; color?: string; gender?: HmpBeastGender; name?: string }): NativeCapturedBeast | null;
    takeCaptured(player: P, id: number): boolean;
    create(species: string, opts: { x: number; y: number; z: number; yaw?: number; name?: string; gender?: HmpBeastGender; color?: string; preferredOwnerId?: number }): NativeBeastHandle;
    catalog?(): Array<{ id: string; colors: Array<{ id: string }> }>;
}

export type Database = Pick<HmpMySQL, "scalar" | "update" | "migrate"> & Partial<Pick<HmpMySQL, "ready">>;

export interface BeastsRepository {
    start(migrations: HmpMySQLMigration[]): Promise<void>;
    /** Null when the character has no row yet, as opposed to an empty bag. */
    load(characterId: number): Promise<HmpStoredBeast[] | null>;
    save(characterId: number, beasts: HmpStoredBeast[]): Promise<void>;
}

export interface BeastsDependencies<P extends HmpBeastPlayer> {
    config: BeastsConfig;
    /** Null on a host without beast capture: the resource then keeps nothing. */
    native: NativeBeasts<P> | null;
    repository: BeastsRepository;
    migrations: HmpMySQLMigration[];
    core: Pick<HmpCore<P>, "characters">;
    players(): P[];
    /** Where a player stands and faces (yaw in degrees), or null when the server does not know. */
    positionOf(player: P): (HmpBeastPosition & { yaw: number }) | null;
    emit(eventName: string, payload: unknown): void;
    logger?: Pick<HmpLogger, "warn" | "info">;
    now?: () => number;
    uid?: () => string;
}

export interface BeastsService<P extends HmpBeastPlayer> extends Omit<HmpBeastsServer<P>, "menu"> {
    /** Migrates, then loads the bag of every player already playing a character; once. */
    ready(): Promise<void>;
    /** A character finished loading: its bag goes into the player's game. */
    attach(player: P, characterId: number): Promise<void>;
    /** A character is unloading: its beasts leave the player's game, so the next character starts empty. */
    detach(player: P): void;
    /** The beastCaptured event. */
    captured(player: P, captured: NativeCapturedBeast): Promise<void>;
    /** The beastReleased event. */
    released(player: P, released: NativeCapturedBeast, at: HmpBeastPosition): Promise<void>;
    /** The player's session ended; the game's bag went with the connection. */
    disconnect(player: P): void;
    stop(): void;
}
