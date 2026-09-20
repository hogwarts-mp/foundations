import type { HmpCore, HmpCoreCharacter, HmpCoreSession } from "../../hmp-core/types";
import type { HmpInventory } from "../../hmp-inventory/types";
import type { HmpLogger } from "../../hmp-lib/types";

export type Player = HogwartsMpPlayer;
export type Core = HmpCore<Player>;
export type Inventory = HmpInventory<Player>;

export type StartingGearEntry = Omit<Extract<HogwartsMpInventoryPatchOperation, { op: "give" }>, "op">;

export interface CharacterConfig extends Record<string, unknown> {
    autoOpenOnJoin: boolean;
    allowDelete: boolean;
    allowCloseWithActiveCharacter: boolean;
    command: string;
    appearanceTimeoutMs: number;
    startingGear: StartingGearEntry[];
    title: string;
    subtitle: string;
}

export interface CharacterEvents {
    emit(eventName: string, payload: unknown): unknown;
}

export interface CharacterFlowOptions {
    core: Core;
    events?: CharacterEvents | null;
    logger?: Pick<HmpLogger, "warn" | "error">;
    config?: Partial<CharacterConfig>;
    isTransmogAllowed?: (characterId: string) => boolean;
}

export interface CharacterEventPayload {
    session: HmpCoreSession<Player>;
    character: HmpCoreCharacter;
}

export interface CharacterOpenOptions {
    mode?: string;
    autoCreate?: boolean;
}

export interface CharacterNameInput {
    first?: unknown;
    last?: unknown;
}
