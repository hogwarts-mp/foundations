import catalogModule = require("../shared/catalog");
import loadoutsModule = require("../shared/loadouts");
import configModule = require("./config");
import policyModule = require("./policy");
import providersModule = require("../shared/providers");
import type { HmpSpellEntitlements, HmpSpellLoadoutAssignments, HmpSpellPlayer, HmpSpellProviderDefinition, HmpSpellProviderInfo, HmpSpellRule } from "../types";
import type { SpellDependencies, SpellService } from "./internal";

const { catalog, resolveSpell } = catalogModule;
const { cloneLoadoutAssignments, normalizeLoadoutAssignments, normalizeSlotSpellId } = loadoutsModule;
const { normalizeProvider, resolveProvidedSpell } = providersModule;
const { normalizeRule } = configModule;
const { evaluateRules } = policyModule;
const METADATA_KEY = "hmp-spells:entitlements";
const ASSIGNMENTS_METADATA_KEY = "hmp-spells:loadout-assignments";

function sanitizeEntitlements(raw: unknown): HmpSpellEntitlements {
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const spells = Array.isArray(value.spells)
        ? [...new Set(value.spells.map((spell) => resolveSpell(String(spell))).filter((spell): spell is string => !!spell))].sort()
        : [];
    const rawLoadouts = value.bonusLoadouts;
    const bonusLoadouts = Number.isSafeInteger(Number(rawLoadouts)) && Number(rawLoadouts) >= 0 && Number(rawLoadouts) <= 3
        ? Number(rawLoadouts) : null;
    return { spells, bonusLoadouts };
}

function createSpellService<P extends HmpSpellPlayer>(dependencies: SpellDependencies<P>): SpellService<P> {
    const { core, config } = dependencies;
    const now = dependencies.now || Date.now;
    const startedAt = now();
    const synced = new Set<number>();
    const runtimeRules = new Map<string, HmpSpellRule>();
    const runtimeProviders = new Map<string, HmpSpellProviderInfo>();
    let stopped = false;

    const ruleKey = (resource: string, id: string) => `${resource}:${id}`;
    const allRules = () => [...config.rules, ...runtimeRules.values()];
    const activeCharacter = (player: P) => core.characters.active(player);

    async function read(player: P): Promise<HmpSpellEntitlements> {
        const character = activeCharacter(player);
        if (!character) return { spells: [], bonusLoadouts: null };
        return sanitizeEntitlements(await core.metadata.getCharacter(character.id, METADATA_KEY));
    }

    async function write(player: P, value: HmpSpellEntitlements): Promise<void> {
        const character = activeCharacter(player);
        if (!character) throw new Error("No character is active");
        await core.metadata.setCharacter(character.id, METADATA_KEY, { version: 1, spells: [...value.spells].sort(), ...(value.bonusLoadouts === null ? {} : { bonusLoadouts: value.bonusLoadouts }) });
    }

    async function readAssignmentsForCharacter(characterId: number): Promise<HmpSpellLoadoutAssignments | null> {
        const stored = await core.metadata.getCharacter(characterId, ASSIGNMENTS_METADATA_KEY) as { assignments?: unknown } | undefined;
        return normalizeLoadoutAssignments(stored?.assignments);
    }

    async function readAssignments(player: P): Promise<HmpSpellLoadoutAssignments | null> {
        const character = activeCharacter(player);
        return character ? readAssignmentsForCharacter(character.id) : null;
    }

    async function setAssignments(player: P, rawAssignments: HmpSpellLoadoutAssignments, context = {}, syncClient = true): Promise<boolean> {
        const character = activeCharacter(player);
        if (!character) throw new Error("No character is active");
        const assignments = normalizeLoadoutAssignments(rawAssignments);
        if (!assignments) throw new TypeError("assignments must contain four loadouts with four spell names or null slots each");
        const stored = await core.metadata.getCharacter(character.id, ASSIGNMENTS_METADATA_KEY) as { assignments?: unknown } | undefined;
        const previous = normalizeLoadoutAssignments(stored?.assignments);
        for (let loadout = 0; loadout < 4; loadout++) for (let slot = 0; slot < 4; slot++) {
            const spellRef = assignments[loadout][slot];
            // Preserve an unavailable provider reference already stored for the character, but do
            // not let a client invent new provider ids. It becomes usable again when its owner loads.
            if (spellRef && !resolveProviderSpell(spellRef) && previous?.[loadout][slot] !== spellRef) {
                throw new TypeError(`Unknown spell provider reference '${spellRef}'`);
            }
        }
        if (JSON.stringify(previous) === JSON.stringify(assignments)) return false;
        await core.metadata.setCharacter(character.id, ASSIGNMENTS_METADATA_KEY, { version: 2, assignments });
        if (syncClient) await sync(player);
        dependencies.emit?.("hmp:spells:assignments", { ...contextPayload(player, null, context, character), assignments });
        return true;
    }

    function providerList(resource?: string): HmpSpellProviderInfo[] {
        return [...runtimeProviders.values()]
            .filter((provider) => !resource || provider.resource === resource)
            .map((provider) => ({ ...provider, spells: provider.spells.map((spell) => ({ ...spell })) }));
    }

    function resolveProviderSpell(spellRef: string) {
        return resolveProvidedSpell(spellRef, providerList());
    }

    async function setSlot(player: P, rawLoadout: number, rawSlot: number, rawSpellRef: string | null, context = {}): Promise<boolean> {
        const loadout = Number(rawLoadout);
        const slot = Number(rawSlot);
        if (!Number.isSafeInteger(loadout) || loadout < 0 || loadout > 3) throw new TypeError("loadout must be an integer from 0 to 3");
        if (!Number.isSafeInteger(slot) || slot < 0 || slot > 3) throw new TypeError("slot must be an integer from 0 to 3");
        const spellRef = rawSpellRef === null ? null : normalizeSlotSpellId(rawSpellRef);
        if (rawSpellRef !== null && (!spellRef || !resolveProviderSpell(spellRef))) throw new TypeError(`Unknown spell provider reference '${rawSpellRef}'`);
        const current = await readAssignments(player) || [
            [null, null, null, null], [null, null, null, null],
            [null, null, null, null], [null, null, null, null],
        ];
        if (current[loadout][slot] === spellRef) return false;
        const next = cloneLoadoutAssignments(current);
        next[loadout][slot] = spellRef;
        return setAssignments(player, next, context);
    }

    async function resolve(player: P) {
        if (stopped) throw new Error("hmp-spells is stopped");
        const character = activeCharacter(player);
        const [groups, entitlements, assignments] = await Promise.all([
            core.groups.effective(player),
            character ? core.metadata.getCharacter(character.id, METADATA_KEY).then(sanitizeEntitlements) : Promise.resolve({ spells: [], bonusLoadouts: null }),
            character ? readAssignmentsForCharacter(character.id) : Promise.resolve(null),
        ]);
        const policy = evaluateRules(allRules(), groups, entitlements);
        // An active character owns its count instead of inheriting the previous character's perks.
        if (character && policy.bonusLoadouts === null) policy.bonusLoadouts = 0;
        return { player, character, groups, entitlements, assignments, providers: providerList(), policy };
    }

    // hmp-core creates the session only after an awaited database round-trip, so playerConnect and the
    // world-readiness events always arrive first. hmp:session:ready re-syncs moments later, so treat a
    // session-less player as not-yet rather than as the failure it would otherwise be logged as.
    async function sync(player: P) {
        if (!core.sessions.isReady(player)) return null;
        const resolution = await resolve(player);
        player.emit("hmp-spells:policy", JSON.stringify({
            ...resolution.policy,
            characterId: resolution.character?.id ?? null,
            assignments: resolution.assignments,
            providers: resolution.providers,
        }));
        synced.add(Number(player.id));
        return resolution.policy;
    }

    async function syncAll(): Promise<number> {
        const results = await Promise.all(dependencies.players().map(sync));
        return results.filter(Boolean).length;
    }

    function contextPayload(player: P, spell: string | null, context: { resource?: string; actor?: P; reason?: string } = {}, character = activeCharacter(player)) {
        return { player, character, spell, resource: context.resource || "unknown", actor: context.actor || null, reason: String(context.reason || "").slice(0, 500) };
    }

    async function grant(player: P, rawSpell: string, context = {}): Promise<boolean> {
        const spell = resolveSpell(rawSpell);
        if (!spell) throw new TypeError(`Unknown spell '${rawSpell}'`);
        const value = await read(player);
        if (value.spells.includes(spell)) return false;
        value.spells.push(spell);
        await write(player, value);
        await sync(player);
        dependencies.emit?.("hmp:spells:granted", contextPayload(player, spell, context));
        return true;
    }

    async function revoke(player: P, rawSpell: string, context = {}): Promise<boolean> {
        const spell = resolveSpell(rawSpell);
        if (!spell) throw new TypeError(`Unknown spell '${rawSpell}'`);
        const value = await read(player);
        if (!value.spells.includes(spell)) return false;
        value.spells = value.spells.filter((entry) => entry !== spell);
        await write(player, value);
        await sync(player);
        dependencies.emit?.("hmp:spells:revoked", contextPayload(player, spell, context));
        return true;
    }

    async function clear(player: P, context = {}): Promise<number> {
        const value = await read(player);
        if (!value.spells.length) return 0;
        const count = value.spells.length;
        value.spells = [];
        await write(player, value);
        await sync(player);
        dependencies.emit?.("hmp:spells:cleared", { ...contextPayload(player, null, context), count });
        return count;
    }

    async function setLoadouts(player: P, rawCount: number, context = {}): Promise<boolean> {
        const count = Number(rawCount);
        if (!Number.isSafeInteger(count) || count < 0 || count > 3) throw new TypeError("bonusLoadouts must be an integer from 0 to 3");
        const value = await read(player);
        if (value.bonusLoadouts === count) return false;
        value.bonusLoadouts = count;
        await write(player, value);
        await sync(player);
        dependencies.emit?.("hmp:spells:loadouts", { ...contextPayload(player, null, context), bonusLoadouts: count, managed: true });
        return true;
    }

    async function unmanageLoadouts(player: P, context = {}): Promise<boolean> {
        const value = await read(player);
        if (value.bonusLoadouts === null) return false;
        value.bonusLoadouts = null;
        await write(player, value);
        await sync(player);
        dependencies.emit?.("hmp:spells:loadouts", { ...contextPayload(player, null, context), bonusLoadouts: null, managed: false });
        return true;
    }

    function unregister(id: string, resource: string): boolean {
        const removed = runtimeRules.delete(ruleKey(String(resource), String(id)));
        if (removed && !stopped) void syncAll();
        return removed;
    }

    function register(rawRule: HmpSpellRule): () => boolean {
        if (stopped) throw new Error("hmp-spells is stopped");
        const rule = normalizeRule(rawRule, runtimeRules.size, rawRule.resource);
        const key = ruleKey(rule.resource, rule.id);
        if (runtimeRules.has(key)) throw new Error(`Spell rule '${rule.id}' is already registered by '${rule.resource}'`);
        runtimeRules.set(key, rule);
        void syncAll();
        let active = true;
        return () => {
            if (!active) return false;
            active = false;
            return unregister(rule.id, rule.resource);
        };
    }

    function clearRules(resource: string): number {
        let count = 0;
        for (const [key, rule] of runtimeRules) if (rule.resource === resource) { runtimeRules.delete(key); count++; }
        if (count && !stopped) void syncAll();
        return count;
    }

    function unregisterProvider(id: string, resource: string): boolean {
        const provider = runtimeProviders.get(String(id));
        if (!provider || provider.resource !== String(resource)) return false;
        runtimeProviders.delete(provider.id);
        if (!stopped) void syncAll();
        return true;
    }

    function registerProvider(rawProvider: HmpSpellProviderDefinition): () => boolean {
        if (stopped) throw new Error("hmp-spells is stopped");
        const provider = normalizeProvider(rawProvider);
        if (runtimeProviders.has(provider.id)) throw new Error(`Spell provider '${provider.id}' is already registered`);
        runtimeProviders.set(provider.id, provider);
        void syncAll();
        let active = true;
        return () => {
            if (!active) return false;
            active = false;
            return unregisterProvider(provider.id, provider.resource);
        };
    }

    function clearProviders(resource: string): number {
        let count = 0;
        for (const provider of [...runtimeProviders.values()]) {
            if (provider.resource !== resource) continue;
            runtimeProviders.delete(provider.id);
            count++;
        }
        if (count && !stopped) void syncAll();
        return count;
    }

    return Object.freeze({
        catalog,
        // The network handler acknowledges this save separately. Replaying all slots here would
        // run SlotSpellFromCode while the native menu is open, replaying sound/UI side effects.
        acceptClientAssignments: (player: P, assignments: HmpSpellLoadoutAssignments, context = {}) => setAssignments(player, assignments, context, false),
        policy: Object.freeze({ resolve, sync, syncAll }),
        rules: Object.freeze({
            register, unregister, clear: clearRules,
            list: (resource?: string) => [...runtimeRules.values()].filter((rule) => !resource || rule.resource === resource).map((rule) => ({ ...rule })),
            refresh: syncAll,
        }),
        providers: Object.freeze({
            register: registerProvider,
            unregister: unregisterProvider,
            clear: clearProviders,
            get: (id: string) => providerList().find((provider) => provider.id === id) || null,
            list: providerList,
            resolve: resolveProviderSpell,
        }),
        grants: Object.freeze({ list: async (player: P) => (await read(player)).spells, grant, revoke, clear }),
        loadouts: Object.freeze({
            get: async (player: P) => (await read(player)).bonusLoadouts,
            set: setLoadouts,
            unmanage: unmanageLoadouts,
            getAssignments: readAssignments,
            setAssignments,
            setSlot,
        }),
        status: () => ({ state: stopped ? "stopped" as const : "ready" as const, catalogSize: catalog.list().length, configuredRules: config.rules.length, runtimeRules: runtimeRules.size, providers: runtimeProviders.size, syncedPlayers: synced.size, uptimeMs: now() - startedAt }),
        stop: () => { stopped = true; synced.clear(); runtimeRules.clear(); runtimeProviders.clear(); },
    });
}

export = { createSpellService, sanitizeEntitlements, ASSIGNMENTS_METADATA_KEY, METADATA_KEY };
