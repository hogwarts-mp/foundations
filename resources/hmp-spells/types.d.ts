import type { HmpCoreCharacter, HmpCoreGroup } from "../hmp-core/types";

export interface HmpSpellPlayer {
    id: number;
    nickname: string;
    connected?: boolean;
    emit(eventName: string, payload?: unknown): void;
    sendChat?(message: string): void;
}

export interface HmpSpellDefinition {
    name: string;
    lockId: string;
}

export interface HmpSpellGroupRequirement {
    key: string;
    minimumGrade?: number;
}

export interface HmpSpellMatch {
    groups: ReadonlyArray<HmpSpellGroupRequirement>;
    groupMode?: "any" | "all";
}

export interface HmpSpellRule {
    id: string;
    resource: string;
    priority: number;
    action: "allow" | "deny";
    spells?: "*" | ReadonlyArray<string>;
    /** Allow rules may grant this many bonus diamonds. Omit to leave the count unspecified by this rule. */
    bonusLoadouts?: number;
    match?: HmpSpellMatch;
}

export interface HmpResolvedSpellPolicy {
    unlockSpells: string[];
    /** Active characters resolve to 0-3 bonus diamonds, defaulting to 0. null leaves native perks unmanaged. */
    bonusLoadouts: number | null;
    /** Every catalog spell the rules do not allow. An unlock sticks, so a revoke has to name the lock
     * for the client to take it back; dropping it from unlockSpells changes nothing. */
    lockSpells: string[];
}

export interface HmpSpellEntitlements {
    spells: string[];
    /** null means no character override; applicable rules or the one-loadout default determine the count. */
    bonusLoadouts: number | null;
}

export type HmpSpellLoadoutSlots = [string | null, string | null, string | null, string | null];
export type HmpSpellLoadoutAssignments = [HmpSpellLoadoutSlots, HmpSpellLoadoutSlots, HmpSpellLoadoutSlots, HmpSpellLoadoutSlots];

export interface HmpProvidedSpell {
    /** Stable provider-local identifier used in saved slots as provider:id. */
    id: string;
    label: string;
    /** native uses registered gameplay names (including modded spells); record is explicit API casting only. */
    kind: "record" | "native";
    /** Required for record spells: plugin-rooted Package.Object SpellToolRecord path. */
    recordPath?: string;
    /** Required for native compatibility spells: the native gameplay spell name. */
    nativeName?: string;
    /** Optional provider-owned icon URL/path for custom HUDs. */
    icon?: string;
}

export interface HmpSpellProviderDefinition {
    /** Globally unique stable id; "native" and "record" are reserved compatibility providers. */
    id: string;
    /** Resource owning this registration; it is removed automatically when that resource stops. */
    resource: string;
    label?: string;
    spells: ReadonlyArray<HmpProvidedSpell>;
}

export interface HmpSpellProviderInfo extends HmpSpellProviderDefinition {
    label: string;
    spells: HmpProvidedSpell[];
}

export interface HmpResolvedProvidedSpell extends HmpProvidedSpell {
    provider: string;
    ref: string;
}

export interface HmpSpellResolution<P = HmpSpellPlayer> {
    player: P;
    character: HmpCoreCharacter | null;
    groups: HmpCoreGroup[];
    entitlements: HmpSpellEntitlements;
    assignments: HmpSpellLoadoutAssignments | null;
    providers: HmpSpellProviderInfo[];
    policy: HmpResolvedSpellPolicy;
}

export interface HmpSpellCatalogApi {
    resolve(spell: string): string | null;
    get(spell: string): HmpSpellDefinition | null;
    list(search?: string): HmpSpellDefinition[];
}

export interface HmpSpellPolicyApi<P = HmpSpellPlayer> {
    resolve(player: P): Promise<HmpSpellResolution<P>>;
    sync(player: P): Promise<HmpResolvedSpellPolicy>;
    syncAll(): Promise<number>;
}

export interface HmpSpellRulesApi<P = HmpSpellPlayer> {
    register(rule: HmpSpellRule): () => boolean;
    unregister(id: string, resource: string): boolean;
    clear(resource: string): number;
    list(resource?: string): HmpSpellRule[];
    refresh(): Promise<number>;
}

export interface HmpSpellGrantsApi<P = HmpSpellPlayer> {
    list(player: P): Promise<string[]>;
    grant(player: P, spell: string, context?: { resource?: string; actor?: P; reason?: string }): Promise<boolean>;
    revoke(player: P, spell: string, context?: { resource?: string; actor?: P; reason?: string }): Promise<boolean>;
    clear(player: P, context?: { resource?: string; actor?: P; reason?: string }): Promise<number>;
}

export interface HmpSpellLoadoutsApi<P = HmpSpellPlayer> {
    /** Returns the stored character override, or null when unset (not the resolved count). */
    get(player: P): Promise<number | null>;
    /** Sets 0-3 bonus diamonds, for 1-4 total loadouts. */
    set(player: P, bonusLoadouts: number, context?: { resource?: string; actor?: P; reason?: string }): Promise<boolean>;
    /** Clears the character override, restoring applicable rules or the one-loadout default. */
    unmanage(player: P, context?: { resource?: string; actor?: P; reason?: string }): Promise<boolean>;
    getAssignments(player: P): Promise<HmpSpellLoadoutAssignments | null>;
    setAssignments(player: P, assignments: HmpSpellLoadoutAssignments, context?: { resource?: string; actor?: P; reason?: string }): Promise<boolean>;
    setSlot(player: P, loadout: number, slot: number, spellRef: string | null, context?: { resource?: string; actor?: P; reason?: string }): Promise<boolean>;
}

export interface HmpSpellProvidersApi {
    register(provider: HmpSpellProviderDefinition): () => boolean;
    unregister(id: string, resource: string): boolean;
    clear(resource: string): number;
    get(id: string): HmpSpellProviderInfo | null;
    list(resource?: string): HmpSpellProviderInfo[];
    resolve(spellRef: string): HmpResolvedProvidedSpell | null;
}

export interface HmpSpellsStatus {
    state: "ready" | "stopped";
    catalogSize: number;
    configuredRules: number;
    runtimeRules: number;
    providers: number;
    syncedPlayers: number;
    uptimeMs: number;
}

export interface HmpSpellsServer<P = HmpSpellPlayer> {
    catalog: HmpSpellCatalogApi;
    policy: HmpSpellPolicyApi<P>;
    rules: HmpSpellRulesApi<P>;
    providers: HmpSpellProvidersApi;
    grants: HmpSpellGrantsApi<P>;
    loadouts: HmpSpellLoadoutsApi<P>;
    status(): HmpSpellsStatus;
}
