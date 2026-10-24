import type { HmpCore, HmpCoreGroup } from "../../hmp-core/types";
import type { HmpDefinedSpell, HmpSpellPlayer, HmpSpellRule, HmpSpellsServer } from "../types";

export interface SpellConfig {
    command: string;
    enableCommands: boolean;
    adminGroups: Array<{ key: string; minimumGrade?: number }>;
    rules: HmpSpellRule[];
    definitions: HmpDefinedSpell[];
    maxCastReportsPerSecond: number;
}

// The server half of the host's Spells global; a host without Spells.define has none of it.
export type HostSpellDefinitions = Pick<typeof Spells, "define" | "remove" | "get" | "list">;

export interface SpellDependencies<P extends HmpSpellPlayer> {
    core: HmpCore<P>;
    config: SpellConfig;
    definitions?: HostSpellDefinitions | null;
    players(): P[];
    emit?(eventName: string, ...args: unknown[]): unknown;
    now?: () => number;
}

export interface SpellService<P extends HmpSpellPlayer> extends HmpSpellsServer<P> {
    // Client-originated slots are already applied locally; persist without replaying policy.
    acceptClientAssignments: HmpSpellsServer<P>["loadouts"]["setAssignments"];
    stop(): void;
}

export type EffectiveGroups = ReadonlyArray<Pick<HmpCoreGroup, "key" | "grade">>;
