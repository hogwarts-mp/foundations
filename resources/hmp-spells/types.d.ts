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

/** Numbers replacing the base spell's; a missing key keeps the base's, and the host clamps each to its game-data range. */
export interface HmpDefinedSpellStats {
    damage?: number;
    objectDamage?: number;
    cooldown?: number;
    range?: number;
    projectileSpeed?: number;
    projectileGravity?: number;
    duration?: number;
    playerDuration?: number;
    chargeTime?: number;
    impulse?: number;
}

/** Parts taken from other player spells, each named as in its DA_<spell>SpellRecord; a missing key keeps the base's. */
export interface HmpDefinedSpellParts {
    projectile?: string;
    onHit?: string;
    cast?: string;
    muzzle?: string;
}

/** A server-defined spell (host `Spells.define`): its own name, lock, slot and numbers, running a player spell's class. */
export interface HmpDefinedSpell {
    /** 3-32 characters, a letter then letters, digits or _. It is granted, slotted and cast by this id and locks as Spell_<id>. */
    id: string;
    /** Resource owning this definition; it is removed when that resource stops. */
    resource: string;
    /** The player spell whose class it runs, as in its DA_<base>SpellRecord, e.g. Confringo. */
    base: string;
    /** Spell menu and bar title, at most 48 bytes. Default: the id. */
    name?: string;
    /** Spell menu text, at most 300 bytes. */
    description?: string;
    /** A PNG for its symbol, as "<resource>/<path>.png" shipped in that resource's `files`. Default: the base's. */
    icon?: string;
    /** Another player spell whose line the caster speaks, or "none". Default: the base's. */
    incantation?: string;
    stats?: HmpDefinedSpellStats;
    parts?: HmpDefinedSpellParts;
}

/** A defined spell as the host holds it; `resource` is null for one defined outside hmp-spells. */
export interface HmpDefinedSpellInfo {
    id: string;
    resource: string | null;
    base: string;
    lock: string;
    name: string;
    description: string;
    icon: string | null;
    incantation: string | null;
    stats: HmpDefinedSpellStats;
    parts: HmpDefinedSpellParts;
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

/** The `hmp:spells:cast` payload. Every report is the caster's client's word: never authorize consequences with it. */
export interface HmpSpellCastReport<P = HmpSpellPlayer> {
    player: P;
    character: HmpCoreCharacter | null;
    /** A game spell's record path, or a server-defined spell's id. */
    spell: string;
    name: string;
    lockId: string | null;
    /** Whether the resolved policy unlocks `lockId` for the caster. */
    entitled: boolean;
    advisory: true;
    /** Server-defined spells only, from the host's playerSpellCast: the aim's world yaw in degrees and the wand tip as the cast began. */
    cast?: { aimYaw: number; wand: { x: number; y: number; z: number } };
    receivedAt: string;
}

export interface HmpSpellCatalogApi {
    resolve(spell: string): string | null;
    get(spell: string): HmpSpellDefinition | null;
    list(search?: string): HmpSpellDefinition[];
}

export interface HmpSpellPolicyApi<P = HmpSpellPlayer> {
    resolve(player: P): Promise<HmpSpellResolution<P>>;
    // null when the player has no hmp-core session yet; hmp:session:ready syncs them.
    sync(player: P): Promise<HmpResolvedSpellPolicy | null>;
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

export interface HmpSpellDefinitionsApi {
    /** False on a host without `Spells.define`, where register throws. */
    supported(): boolean;
    /** Defines the spell on every client; throws on a bad definition or an id already defined. */
    register(definition: HmpDefinedSpell): () => boolean;
    unregister(id: string, resource: string): boolean;
    clear(resource: string): number;
    get(id: string): HmpDefinedSpellInfo | null;
    /** Every spell the host has defined, or only those `resource` registered here. */
    list(resource?: string): HmpDefinedSpellInfo[];
}

export interface HmpSpellsStatus {
    state: "ready" | "stopped";
    catalogSize: number;
    configuredRules: number;
    runtimeRules: number;
    providers: number;
    definitions: number;
    syncedPlayers: number;
    uptimeMs: number;
}

export interface HmpSpellsServer<P = HmpSpellPlayer> {
    catalog: HmpSpellCatalogApi;
    policy: HmpSpellPolicyApi<P>;
    rules: HmpSpellRulesApi<P>;
    providers: HmpSpellProvidersApi;
    definitions: HmpSpellDefinitionsApi;
    grants: HmpSpellGrantsApi<P>;
    loadouts: HmpSpellLoadoutsApi<P>;
    status(): HmpSpellsStatus;
}
