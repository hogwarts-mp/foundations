import type { HmpCore } from "../../hmp-core/types";
import type { HmpInventory } from "../../hmp-inventory/types";
import type { HmpUiServer } from "../../hmp-ui/types";
import type { HmpInteractPlayer, HmpInteractServer, HmpInteractionDefinition } from "../types";

export interface InteractConfig {
    /** Registers the closed-test command that toggles a player's zone outlines. */
    enableCommands: boolean;
    command: string;
}

export interface InteractLogger {
    info(...args: unknown[]): unknown;
    warn(...args: unknown[]): unknown;
    error(...args: unknown[]): unknown;
}

export interface InteractEvents {
    emit(eventName: string, ...args: unknown[]): unknown;
}

export interface InteractWorldObjects {
    create(key: string, model: string | number, options: {
        x: number;
        y: number;
        z: number;
        pitch?: number;
        yaw?: number;
        roll?: number;
        scale?: number;
        collision?: boolean;
        streamRange?: number;
        drawDistance?: number;
        animation?: string;
        material?: string;
        startFx?: string;
    }): unknown;
    destroy(key: string): boolean;
}

export interface InteractCharacters {
    create(key: string, characterId: string, options: {
        x: number;
        y: number;
        z: number;
        yaw?: number;
        scale?: number;
        label?: string;
        promptHeight?: number;
    }): unknown;
    destroy(key: string): boolean;
}

export interface InteractDependencies<P extends HmpInteractPlayer> {
    core: HmpCore<P>;
    inventory: HmpInventory<P>;
    ui: HmpUiServer<P>;
    players(): P[];
    events: InteractEvents;
    worldObjects?: InteractWorldObjects;
    characters?: InteractCharacters;
    logger: InteractLogger;
    now?: () => number;
}

export interface InteractService<P extends HmpInteractPlayer> extends HmpInteractServer<P> {
    unregisterResource(resource: string): number;
    disconnect(player: P): boolean;
    /** The player's client reports them standing up from the interaction's seat, or never seated. */
    stand(player: P, id: string): boolean;
    /** Outlines each zone in the player's snapshot on their screen, or stops; toggles when `enabled` is omitted. */
    setOutlines(player: P, enabled?: boolean): boolean;
    stop(): number;
}

export type StoredInteraction<P extends HmpInteractPlayer> = HmpInteractionDefinition<P>;
