import catalogModule = require("../shared/catalog");
import loadoutsModule = require("../shared/loadouts");
import configModule = require("./config");
import policyModule = require("./policy");
import providersModule = require("../shared/providers");
import type { HmpDefinedSpell, HmpDefinedSpellInfo, HmpSpellEntitlements, HmpSpellLesson, HmpSpellLoadoutAssignments, HmpSpellPlayer, HmpSpellProviderDefinition, HmpSpellProviderInfo, HmpSpellRule } from "../types";
import type { SpellDependencies, SpellService } from "./internal";

const { createCatalog, resolveSpell } = catalogModule;
const { cloneLoadoutAssignments, normalizeLoadoutAssignments, normalizeSlotSpellId } = loadoutsModule;
const { normalizeProvider, resolveProvidedSpell } = providersModule;
const { normalizeDefinition, normalizeRule } = configModule;
const { evaluateRules, ALL_LOCKS } = policyModule;
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
    const host = dependencies.definitions || null;
    // Lower-cased id -> the resource that registered it here, as the host ids are case-blind.
    const definitionOwners = new Map<string, { id: string; resource: string; lock: string }>();
    // A removed spell lives on in connected clients until they reconnect, so keep re-locking it.
    const retiredLocks = new Set<string>();
    let stopped = false;

    function hostDefinitions(): HogwartsMpSpellDefinitionInfo[] {
        try { return host ? host.list() : []; }
        catch (_) { return []; }
    }
    const catalog = createCatalog(() => hostDefinitions().map((definition) => ({ name: definition.id, lockId: definition.lock })));
    const lockTable = () => [...new Set([...ALL_LOCKS, ...hostDefinitions().map((definition) => definition.lock), ...retiredLocks])];

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
        const policy = evaluateRules(allRules(), groups, entitlements, lockTable());
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
        const spell = catalog.resolve(rawSpell);
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
        const spell = catalog.resolve(rawSpell);
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
        const rule = normalizeRule(rawRule, runtimeRules.size, rawRule.resource, catalog.resolve);
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

    function definitionInfo(definition: HogwartsMpSpellDefinitionInfo): HmpDefinedSpellInfo {
        const { id, base, lock, name, description, icon, incantation, stats, parts } = definition;
        return { id, resource: definitionOwners.get(id.toLowerCase())?.resource ?? null, base, lock, name, description, icon, incantation, stats: { ...stats }, parts: { ...parts } };
    }

    function dropDefinition(entry: { id: string; lock: string }): void {
        definitionOwners.delete(entry.id.toLowerCase());
        try { host?.remove(entry.id); }
        catch (_) { /* gone already */ }
        retiredLocks.add(entry.lock);
    }

    function unregisterDefinition(id: string, resource: string): boolean {
        const owned = definitionOwners.get(String(id).toLowerCase());
        if (!owned || owned.resource !== String(resource)) return false;
        dropDefinition(owned);
        if (!stopped) void syncAll();
        return true;
    }

    function registerDefinition(rawDefinition: HmpDefinedSpell): () => boolean {
        if (stopped) throw new Error("hmp-spells is stopped");
        if (!host) throw new Error("Spell definitions need a HogwartsMP host with Spells.define");
        const { resource, ...definition } = normalizeDefinition(rawDefinition, "spell definition", rawDefinition?.resource);
        const owner = definitionOwners.get(definition.id.toLowerCase());
        // The host replaces a spell of the same id, which would take it from whoever defined it.
        if (owner || host.get(definition.id)) throw new Error(`Spell '${definition.id}' is already defined${owner ? ` by '${owner.resource}'` : ""}`);
        const stored = host.define(definition);
        definitionOwners.set(stored.id.toLowerCase(), { id: stored.id, resource, lock: stored.lock });
        retiredLocks.delete(stored.lock);
        void syncAll();
        let active = true;
        return () => {
            if (!active) return false;
            active = false;
            return unregisterDefinition(stored.id, resource);
        };
    }

    function clearDefinitions(resource: string): number {
        const owned = [...definitionOwners.values()].filter((entry) => entry.resource === resource);
        for (const entry of owned) dropDefinition(entry);
        if (owned.length && !stopped) void syncAll();
        return owned.length;
    }

    // One lesson per player at a time, as a client runs one at once. A result counts only for the
    // offer it answers: the client can skip the lesson itself, never learn a spell it wasn't offered.
    type PendingLesson = { token: number; lesson: HmpSpellLesson; characterId: number; context: { resource?: string; actor?: P; reason?: string } };
    const pendingLessons = new Map<number, PendingLesson>();
    let lessonTokens = 0;

    function settleLesson(player: P, pending: PendingLesson, status: string, failure: string | null, granted: boolean): void {
        dependencies.emit?.("hmp:spells:lesson", { ...contextPayload(player, pending.lesson.spell, pending.context), lesson: pending.lesson.id, status, failure, granted });
    }

    async function offerLesson(player: P, rawId: string, context = {}): Promise<boolean> {
        if (stopped) throw new Error("hmp-spells is stopped");
        const lesson = config.lessons.find((entry) => entry.id === String(rawId));
        if (!lesson) throw new TypeError(`Unknown spell lesson '${rawId}'`);
        const character = activeCharacter(player);
        if (!character) throw new Error("No character is active");
        const id = Number(player.id);
        if (pendingLessons.has(id)) return false;
        const { policy } = await resolve(player);
        // Checked again, as another offer may have landed while the policy resolved.
        if (policy.unlockSpells.includes(lesson.spell) || pendingLessons.has(id)) return false;
        const token = ++lessonTokens;
        pendingLessons.set(id, { token, lesson, characterId: character.id, context });
        player.emit("hmp-spells:lesson", JSON.stringify({ token, id: lesson.id, lesson: lesson.lesson }));
        return true;
    }

    function cancelLesson(player: P): boolean {
        const pending = pendingLessons.get(Number(player.id));
        if (!pending) return false;
        pendingLessons.delete(Number(player.id));
        player.emit("hmp-spells:lesson-cancel", JSON.stringify({ token: pending.token }));
        settleLesson(player, pending, "cancelled", "withdrawn", false);
        return true;
    }

    async function acceptLessonResult(player: P, result: { token?: unknown; status?: unknown; reason?: unknown }): Promise<boolean> {
        const pending = pendingLessons.get(Number(player.id));
        if (!pending || Number(result.token) !== pending.token) return false;
        pendingLessons.delete(Number(player.id));
        const status = result.status === "completed" || result.status === "cancelled" ? result.status : "failed";
        // The offer was for one character; finishing after a switch teaches the new one nothing.
        if (status === "completed" && activeCharacter(player)?.id !== pending.characterId) {
            settleLesson(player, pending, "failed", "character-changed", false);
            return false;
        }
        const granted = status === "completed" && await grant(player, pending.lesson.spell, pending.context);
        settleLesson(player, pending, status, status === "completed" ? null : String(result.reason || status).slice(0, 100), granted);
        return granted;
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
        definitions: Object.freeze({
            supported: () => !!host,
            register: registerDefinition,
            unregister: unregisterDefinition,
            clear: clearDefinitions,
            get(id: string) {
                const definition = host?.get(String(id));
                return definition ? definitionInfo(definition) : null;
            },
            list: (resource?: string) => hostDefinitions().map(definitionInfo).filter((definition) => !resource || definition.resource === resource),
        }),
        grants: Object.freeze({ list: async (player: P) => (await read(player)).spells, grant, revoke, clear }),
        lessons: Object.freeze({
            list: () => config.lessons.map((lesson) => ({ ...lesson, lesson: { ...lesson.lesson } })),
            offer: offerLesson,
            cancel: cancelLesson,
        }),
        acceptLessonResult,
        forgetPlayer: (player: P) => { pendingLessons.delete(Number(player.id)); },
        loadouts: Object.freeze({
            get: async (player: P) => (await read(player)).bonusLoadouts,
            set: setLoadouts,
            unmanage: unmanageLoadouts,
            getAssignments: readAssignments,
            setAssignments,
            setSlot,
        }),
        status: () => ({ state: stopped ? "stopped" as const : "ready" as const, catalogSize: catalog.list().length, configuredRules: config.rules.length, runtimeRules: runtimeRules.size, providers: runtimeProviders.size, definitions: definitionOwners.size, syncedPlayers: synced.size, uptimeMs: now() - startedAt }),
        stop: () => {
            stopped = true; synced.clear(); runtimeRules.clear(); runtimeProviders.clear();
            for (const entry of [...definitionOwners.values()]) dropDefinition(entry);
            retiredLocks.clear(); pendingLessons.clear();
        },
    });
}

export = { createSpellService, sanitizeEntitlements, ASSIGNMENTS_METADATA_KEY, METADATA_KEY };
