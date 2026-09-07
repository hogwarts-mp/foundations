import loadoutsModule = require("../shared/loadouts");
import providersModule = require("../shared/providers");
import type {
    HmpResolvedProvidedSpell,
    HmpResolvedSpellPolicy,
    HmpSpellLoadoutAssignments,
    HmpSpellProviderInfo,
} from "../types";

const { cloneLoadoutAssignments, normalizeLoadoutAssignments, normalizeSlotSpellId } = loadoutsModule;
const { normalizeProviderList, resolveProvidedSpell } = providersModule;

interface NativeSpellLoadout {
    index: number;
    current: number;
    source?: string;
    slots: Array<string | null>;
}

interface NativeSpellCastResult {
    accepted: boolean;
    slot: number;
    spellName: string | null;
    reason: string | null;
}

interface NativeSpells {
    setPolicy(lockIds: string[], bonusLoadouts?: number, relockIds?: string[]): void;
    currentLoadout(): number | null;
    loadout(loadoutIndex?: number): NativeSpellLoadout | null;
    setLoadoutSlot(slot: number, spellName: string | null, loadoutIndex?: number, emitAssignmentEvent?: boolean): boolean;
    cast(slot: number): NativeSpellCastResult;
    castRecord(recordPath: string, aimMode?: number): NativeSpellCastResult;
}

interface ClientDependencies {
    spells: NativeSpells;
    events: { emitServer(eventName: string, payload?: unknown): void };
    notify?(message: string): void;
    log?(message: string): void;
    debug?(message: string): void;
}

const EMPTY_ASSIGNMENTS = (): HmpSpellLoadoutAssignments => [
    [null, null, null, null], [null, null, null, null],
    [null, null, null, null], [null, null, null, null],
];

function parsePayload(raw: unknown): Record<string, unknown> {
    if (typeof raw === "string") {
        try { return JSON.parse(raw) as Record<string, unknown>; }
        catch (_) { return {}; }
    }
    return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
}

const normalizeLockIds = (raw: unknown): string[] => (Array.isArray(raw)
    ? [...new Set(raw.filter((entry): entry is string => typeof entry === "string" && /^Spell_[A-Za-z0-9_]+$/.test(entry)))]
    : []);

function normalizePolicy(raw: unknown): HmpResolvedSpellPolicy {
    const value = parsePayload(raw);
    const unlockSpells = normalizeLockIds(value.unlockSpells);
    const number = Number(value.bonusLoadouts);
    const bonusLoadouts = value.bonusLoadouts !== null && Number.isSafeInteger(number) && number >= 0 && number <= 3 ? number : null;
    return { unlockSpells, bonusLoadouts, lockSpells: normalizeLockIds(value.lockSpells) };
}

function createSpellClient(dependencies: ClientDependencies) {
    let current = normalizePolicy({});
    let characterId: number | null = null;
    let assignments = EMPTY_ASSIGNMENTS();
    let nativeProjection = EMPTY_ASSIGNMENTS();
    let providers: HmpSpellProviderInfo[] = [];
    let assignmentsDirty = false;
    let internalProjectionDepth = 0;
    let ready = false;
    let stopped = false;

    function activeLoadout(): number {
        const index = Number(dependencies.spells.currentLoadout());
        return Number.isSafeInteger(index) && index >= 0 && index <= 3 ? index : 0;
    }

    function resolveSpell(spellRef: string | null): HmpResolvedProvidedSpell | null {
        return spellRef ? resolveProvidedSpell(spellRef, providers) : null;
    }

    function projectSlot(loadout: number, slot: number, spellRef: string | null, emitAssignmentEvent = false): boolean {
        const spell = resolveSpell(spellRef);
        // Gameplay names include Creator Kit spells registered with the native slot system.
        // Record-only/unavailable references stay saved, but have no native slot mapping; clear
        // that cell so it cannot retain another character's spell.
        const nativeName = spell?.kind === "native" ? spell.nativeName || null : null;
        internalProjectionDepth++;
        try {
            const accepted = dependencies.spells.setLoadoutSlot(slot, nativeName, loadout, emitAssignmentEvent);
            if (accepted) nativeProjection[loadout][slot] = nativeName;
            return accepted;
        }
        finally { internalProjectionDepth--; }
    }

    function projectAll(previousAssignments?: HmpSpellLoadoutAssignments): number {
        let accepted = 0;
        for (let loadout = 0; loadout < 4; loadout++) for (let slot = 0; slot < 4; slot++) {
            const emitAssignmentEvent = !!previousAssignments
                && previousAssignments[loadout][slot] !== assignments[loadout][slot];
            if (projectSlot(loadout, slot, assignments[loadout][slot], emitAssignmentEvent)) accepted++;
        }
        return accepted;
    }

    function emitAssignments(): void {
        if (characterId === null) return;
        assignmentsDirty = true;
        dependencies.events.emitServer("hmp-spells:assignments", JSON.stringify({ characterId, assignments }));
    }

    function apply(raw: unknown): HmpResolvedSpellPolicy {
        if (stopped) return current;
        const payload = parsePayload(raw);
        const next = normalizePolicy(payload);
        dependencies.spells.setPolicy(next.unlockSpells, next.bonusLoadouts === null ? -1 : next.bonusLoadouts, next.lockSpells ?? []);
        const previousCharacterId = characterId;
        const rawCharacterId = Number(payload.characterId);
        characterId = Number.isSafeInteger(rawCharacterId) && rawCharacterId > 0 ? rawCharacterId : null;
        providers = normalizeProviderList(payload.providers);
        const previousAssignments = assignments;
        const wasReady = ready;
        assignments = normalizeLoadoutAssignments(payload.assignments) || EMPTY_ASSIGNMENTS();
        assignmentsDirty = false;
        const projected = characterId === null ? 0 : projectAll(
            wasReady && characterId === previousCharacterId ? previousAssignments : undefined,
        );
        if (characterId !== null && projected < 16) {
            dependencies.log?.(`[hmp-spells] could not restore ${16 - projected} native slot(s) for character ${characterId}`);
        }
        dependencies.debug?.(`[hmp-spells] loaded ${assignments.flat().filter(Boolean).length} Foundations assignment(s) for character ${characterId ?? "none"}; ${providers.length} provider(s), ${projected}/16 native projections applied`);
        current = next;
        ready = true;
        return current;
    }

    function acknowledgeAssignments(raw: unknown): void {
        const payload = parsePayload(raw);
        const saved = normalizeLoadoutAssignments(payload.assignments);
        if (characterId !== null && Number(payload.characterId) === characterId && saved
            && JSON.stringify(saved) === JSON.stringify(assignments)) {
            assignmentsDirty = false;
            dependencies.debug?.(`[hmp-spells] server confirmed assignments for character ${characterId}`);
        }
    }

    function loadout(index = activeLoadout()): NativeSpellLoadout | null {
        if (!ready || index < 0 || index > 3 || !Number.isSafeInteger(index)) return null;
        return { index, current: activeLoadout(), source: "hmp-spells", slots: [...assignments[index]] };
    }

    function setLoadoutSlot(slot: number, rawSpellRef: string | null, loadoutIndex = activeLoadout()): boolean {
        if (stopped || characterId === null || !Number.isSafeInteger(slot) || slot < 0 || slot > 3
            || !Number.isSafeInteger(loadoutIndex) || loadoutIndex < 0 || loadoutIndex > 3) return false;
        const spellRef = rawSpellRef === null ? null : normalizeSlotSpellId(rawSpellRef);
        if (rawSpellRef !== null && (!spellRef || !resolveSpell(spellRef))) return false;
        if (assignments[loadoutIndex][slot] === spellRef) return projectSlot(loadoutIndex, slot, spellRef);
        const previous = assignments;
        const next = cloneLoadoutAssignments(assignments);
        next[loadoutIndex][slot] = spellRef;
        assignments = next;
        if (!projectSlot(loadoutIndex, slot, spellRef, true)) {
            assignments = previous;
            return false;
        }
        emitAssignments();
        return true;
    }

    function cast(slot: number): NativeSpellCastResult {
        const index = activeLoadout();
        if (!Number.isSafeInteger(slot) || slot < 0 || slot > 3) return { accepted: false, slot, spellName: null, reason: "slot out of range (0-3)" };
        const spellRef = assignments[index][slot];
        if (!spellRef) return { accepted: false, slot, spellName: null, reason: "Foundations spell slot is empty" };
        const spell = resolveSpell(spellRef);
        if (!spell) return { accepted: false, slot, spellName: spellRef, reason: `spell provider for '${spellRef}' is unavailable` };
        if (spell.kind === "record" && spell.recordPath) {
            const result = dependencies.spells.castRecord(spell.recordPath, 0);
            return { ...result, slot, spellName: spellRef };
        }
        if (spell.kind === "native") {
            const result = dependencies.spells.cast(slot);
            return { ...result, spellName: spellRef };
        }
        return { accepted: false, slot, spellName: spellRef, reason: `spell '${spellRef}' has no cast adapter` };
    }

    // API events raised by our own projection are informational for other resources; Foundations
    // already owns that state. External raw API calls and stock-menu events are imported by diffing
    // against the last native projection, preserving unrelated provider-backed slots that project
    // to an intentionally empty native cell.
    function importNativeAssignments(rawEvent?: unknown): boolean {
        if (stopped || characterId === null) return false;
        const event = parsePayload(rawEvent);
        if (event.source === "api" && internalProjectionDepth > 0) return true;
        const observed = EMPTY_ASSIGNMENTS();
        const next = cloneLoadoutAssignments(assignments);
        let changed = false;
        for (let index = 0; index < 4; index++) {
            const state = dependencies.spells.loadout(index);
            if (!state || state.source !== "quick-actions" || state.index !== index || state.slots.length !== 4) {
                dependencies.log?.(`[hmp-spells] assignment import failed for character ${characterId}: unreadable native loadout ${index}`);
                return false;
            }
            for (let slot = 0; slot < 4; slot++) {
                const raw = state.slots[slot];
                const nativeRef = raw ? normalizeSlotSpellId(raw) : null;
                if (raw && !nativeRef) {
                    dependencies.log?.(`[hmp-spells] assignment import failed for character ${characterId}: invalid spell ${raw} in ${index}:${slot}`);
                    return false;
                }
                observed[index][slot] = raw || null;
                if (observed[index][slot] !== nativeProjection[index][slot]) {
                    next[index][slot] = nativeRef;
                    changed = true;
                }
            }
        }
        nativeProjection = observed;
        if (!changed) return true;
        assignments = next;
        dependencies.debug?.(`[hmp-spells] importing ${event.source || "native"} assignments for character ${characterId}`);
        emitAssignments();
        return true;
    }

    function diagnostic(raw: unknown): void {
        const value = parsePayload(raw);
        if (String(value.action || "") !== "loadout") return;
        const state = loadout();
        if (!state) { dependencies.notify?.("[spells] Foundations loadout is not available yet"); return; }
        const labels = state.slots.map((spell, index) => `${index + 1}:${spell || "empty"}`).join(", ");
        dependencies.log?.(`[hmp-spells] Foundations loadout ${state.index + 1}/4: ${labels}`);
        dependencies.notify?.(`[spells] loadout ${state.current + 1}: ${labels}`);
    }

    function reportCast(path: unknown): void {
        const spell = String(path || "").slice(0, 500);
        const name = (spell.match(/\/Spells\/([^/]+)\//) || [])[1] || "";
        dependencies.events.emitServer("hmp-spells:cast", JSON.stringify({ spell, name }));
    }

    function stop(): void {
        if (stopped) return;
        stopped = true;
        dependencies.spells.setPolicy([], -1, []); // stop enforcing; never re-lock on the way out
        current = normalizePolicy({});
        characterId = null;
        assignments = EMPTY_ASSIGNMENTS();
        nativeProjection = EMPTY_ASSIGNMENTS();
        providers = [];
        assignmentsDirty = false;
        ready = false;
    }

    dependencies.events.emitServer("hmp-spells:ready");
    return Object.freeze({
        apply, acknowledgeAssignments, loadout, setLoadoutSlot, cast, importNativeAssignments,
        diagnostic, reportCast, stop,
        status: () => ({ ready, stopped, characterId, assignments, providers, assignmentsDirty, policy: current }),
    });
}

export = { createSpellClient, normalizePolicy, parsePayload };
