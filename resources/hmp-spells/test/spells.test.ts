import assert = require("node:assert");
import fs = require("node:fs");
import os = require("node:os");
import path = require("node:path");
import libConfig = require("../../hmp-lib/server/config");
import catalogModule = require("../shared/catalog");
import configModule = require("../server/config");
import policyModule = require("../server/policy");
import serviceModule = require("../server/service");
import clientModule = require("../client/service");
import loadoutsModule = require("../shared/loadouts");
import providersModule = require("../shared/providers");
import type { HmpSpellLoadoutAssignments, HmpSpellRule } from "../types";

const { catalog } = catalogModule;
const { normalizeDefinition, normalizeRule, loadConfig } = configModule;
const { evaluateRules, ALL_LOCKS } = policyModule;
const { createSpellService, ASSIGNMENTS_METADATA_KEY, METADATA_KEY } = serviceModule;
const { createSpellClient } = clientModule;
const { cloneLoadoutAssignments, normalizeLoadoutAssignments, normalizeSlotSpellId } = loadoutsModule;
const { normalizeProvider, resolveProvidedSpell } = providersModule;

// Loads an owner config through the real hmp-lib loader. Each case gets its own directory because
// config.load goes through require(), which would otherwise serve the first file from cache.
function configOf(root: string, name: string, ...rules: unknown[]) {
    const cwd = path.join(root, name);
    fs.mkdirSync(path.join(cwd, "data"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "data", "hmp-spells.json"), JSON.stringify({ rules }));
    const config = loadConfig({ config: libConfig } as never, { env: {}, cwd });
    return evaluateRules(config.rules, [], { spells: [], bonusLoadouts: null });
}

// The host's server Spells: a defined spell runs a player spell's class and locks as Spell_<id>.
function fakeHost() {
    const table: HogwartsMpSpellDefinitionInfo[] = [];
    const removed: string[] = [];
    const find = (id: string) => table.findIndex((entry) => entry.id.toLowerCase() === String(id).toLowerCase());
    return {
        removed,
        define(input: HogwartsMpSpellDefinitionInput): HogwartsMpSpellDefinitionInfo {
            if (!["Confringo", "Depulso", "Glacius"].includes(input.base)) throw new TypeError(`Spells.define: base '${input.base}' is not a player spell`);
            const stored = { id: input.id, base: input.base, lock: `Spell_${input.id}`, name: input.name || input.id, description: input.description || "", icon: input.icon || null, incantation: input.incantation || null, stats: { ...input.stats }, parts: { ...input.parts } };
            const index = find(input.id);
            if (index >= 0) table[index] = stored;
            else table.push(stored);
            return stored;
        },
        remove(id: string): boolean {
            const index = find(id);
            if (index < 0) return false;
            removed.push(table[index].id);
            table.splice(index, 1);
            return true;
        },
        get: (id: string) => table[find(id)] ?? null,
        list: () => table.map((entry) => ({ ...entry })),
    };
}

async function run(): Promise<void> {
    assert.strictEqual(catalog.resolve("incendio"), "Spell_Incendio");
    assert.strictEqual(catalog.resolve("Bombarda"), "Spell_Expulso");
    assert.strictEqual(catalog.resolve("Spell_Custom_Test"), "Spell_Custom_Test");
    assert.strictEqual(catalog.resolve("not-a-spell"), null);
    assert.ok(catalog.list("lev").some((spell) => spell.name === "Levioso"));
    assert.strictEqual(normalizeSlotSpellId("/MyMod/Spells/DA_Fireball.DA_Fireball"), "record:/MyMod/Spells/DA_Fireball.DA_Fireball");
    assert.strictEqual(normalizeSlotSpellId("  MyMod_Fireball  "), "native:MyMod_Fireball");
    assert.strictEqual(normalizeSlotSpellId("/Game/Spells/DA_BossKiller.DA_BossKiller"), null);
    assert.strictEqual(normalizeSlotSpellId("/MyMod/Spells/DA_A.DA_B"), null);
    assert.strictEqual(normalizeSlotSpellId("bad spell id"), null);
    for (const name of ["_CustomSpell", "A".repeat(64), "A".repeat(65), "A".repeat(100)]) {
        const ref = `native:${name}`;
        assert.strictEqual(normalizeSlotSpellId(name), ref);
        assert.strictEqual(normalizeSlotSpellId(ref), ref, "normalization must be idempotent for every accepted gameplay name");
        assert.strictEqual(resolveProvidedSpell(ref, [])?.nativeName, name);
        const slots = [[name, null, null, null], [null, null, null, null], [null, null, null, null], [null, null, null, null]];
        const normalized = normalizeLoadoutAssignments(slots);
        assert.deepStrictEqual(normalizeLoadoutAssignments(normalized), normalized);
    }
    for (const name of ["", "A".repeat(101), "bad-name", "bad.name", "bad name"]) {
        assert.strictEqual(normalizeSlotSpellId(name), null);
        assert.strictEqual(normalizeSlotSpellId(`native:${name}`), null);
    }
    assert.strictEqual(normalizeSlotSpellId(`custom:${"A".repeat(65)}`), null, "provider-local ids retain their separate limit");

    const rules: HmpSpellRule[] = [
        normalizeRule({ id: "starter", resource: "test", priority: 1000, action: "allow", spells: ["Lumos", "Accio"], bonusLoadouts: 1 }, 0),
        normalizeRule({ id: "restricted", resource: "test", priority: 500, action: "deny", spells: ["Accio"] }, 1),
        normalizeRule({ id: "auror", resource: "test", priority: 100, action: "allow", spells: ["Accio", "Stupefy"], match: { groups: [{ key: "job:auror", minimumGrade: 2 }] } }, 2),
    ];
    const guest = evaluateRules(rules, [], { spells: [], bonusLoadouts: null });
    assert.deepStrictEqual(guest.unlockSpells, ["Spell_Lumos"]);
    assert.strictEqual(guest.bonusLoadouts, 1);
    const auror = evaluateRules(rules, [{ key: "job:auror", grade: 2 }], { spells: ["Spell_Incendio"], bonusLoadouts: 2 });
    assert.deepStrictEqual(auror.unlockSpells, ["Spell_Accio", "Spell_Incendio", "Spell_Lumos", "Spell_Stupefy"]);
    assert.strictEqual(auror.bonusLoadouts, 2);
    // Authoritative both ways: every catalog spell the rules don't allow is named for re-locking, and
    // the two sides never overlap. A denied spell must be revoked, not merely left out.
    assert.deepStrictEqual(guest.lockSpells, ALL_LOCKS.filter((lockId) => lockId !== "Spell_Lumos").sort());
    assert.ok(guest.lockSpells.includes("Spell_Accio"), "a deny rule must actively re-lock, not just withhold");
    assert.ok(guest.lockSpells.includes("Spell_Protego"), "nothing is exempt — vanilla defaults are stated by config, not hardcoded");
    assert.ok(!auror.lockSpells.some((lockId) => auror.unlockSpells.includes(lockId)), "a spell must never be granted and revoked at once");
    // The shipped default must not re-lock what the freeride boot just opened — re-locking
    // Spell_AimMode would silently take right-click aim away on a stock server.
    const shipped = loadConfig({ config: { load: (_path: string, o: { defaults: unknown }) => o.defaults } } as never, { env: {}, cwd: "." });
    const baseline = evaluateRules(shipped.rules, [], { spells: [], bonusLoadouts: null });
    for (const lockId of ["Spell_Protego", "Spell_Stupefy", "Spell_AimMode"]) {
        assert.ok(!baseline.lockSpells.includes(lockId), `default config re-locks ${lockId}`);
    }
    assert.deepStrictEqual(shipped.definitions, [], "the default defines no spells");
    // ...and neither must an owner's own config file: config.load replaces arrays wholesale, so
    // stating `rules` drops the baseline and the policy revokes right-click aim and Stupefy.
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hmp-spells-config-"));
    try {
        const owner = configOf(temp, "starter", { id: "starter", priority: 1000, action: "allow", spells: ["Lumos", "Revelio", "Accio", "Levioso", "Incendio"] });
        for (const lockId of ["Spell_Protego", "Spell_Stupefy", "Spell_AimMode"]) {
            assert.ok(!owner.lockSpells.includes(lockId), `an owner config stating its own rules re-locks ${lockId}`);
        }
        assert.ok(owner.unlockSpells.includes("Spell_Lumos"), "the owner's own rules still apply");
        // The baseline is restored, not enforced — a deny at or below priority 900 still takes it away.
        const wandless = configOf(temp, "wandless", { id: "wandless", priority: 100, action: "deny", spells: ["Protego"] });
        assert.ok(wandless.lockSpells.includes("Spell_Protego"), "an explicit deny must still beat the restored baseline");
        assert.ok(!wandless.lockSpells.includes("Spell_AimMode"), "denying one baseline spell must not drop the others");
        // A rule may name a configured spell by id; the host defines it only once the service starts.
        const definedCwd = path.join(temp, "defined");
        fs.mkdirSync(path.join(definedCwd, "data"), { recursive: true });
        fs.writeFileSync(path.join(definedCwd, "data", "hmp-spells.json"), JSON.stringify({
            definitions: [{ id: "Firestorm", base: "Confringo", stats: { damage: 40 } }],
            rules: [{ id: "fire", priority: 1000, action: "allow", spells: ["firestorm"] }],
        }));
        const definedConfig = loadConfig({ config: libConfig } as never, { env: {}, cwd: definedCwd });
        assert.deepStrictEqual(definedConfig.definitions, [{ id: "Firestorm", resource: "hmp-spells", base: "Confringo", stats: { damage: 40 } }]);
        assert.deepStrictEqual(definedConfig.rules.find((rule) => rule.id === "fire")?.spells, ["Spell_Firestorm"]);
    }
    finally {
        fs.rmSync(temp, { recursive: true, force: true });
    }

    assert.throws(() => normalizeRule({ id: "bad", resource: "x", priority: 1, action: "allow", spells: ["Typo"] }, 0), /unknown spell/);
    assert.throws(() => normalizeRule({ id: "bad", resource: "x", priority: 1, action: "deny", bonusLoadouts: 1 }, 0), /only valid on allow/);
    assert.strictEqual(normalizeLoadoutAssignments([["Lumos"]]), null);
    assert.deepStrictEqual(normalizeLoadoutAssignments([
        ["/MyMod/Spells/DA_Fireball.DA_Fireball", null, null, null], [null, null, null, null],
        [null, null, null, null], [null, null, null, null],
    ])?.[0][0], "record:/MyMod/Spells/DA_Fireball.DA_Fireball");

    const testProvider = normalizeProvider({
        id: "kingsley", resource: "hmp-kingsley", label: "Kingsley",
        spells: [{ id: "fireball", label: "Fireball", kind: "record", recordPath: "/MyMod/Spells/DA_Fireball.DA_Fireball" }],
    });
    assert.strictEqual(resolveProvidedSpell("kingsley:fireball", [testProvider])?.recordPath, "/MyMod/Spells/DA_Fireball.DA_Fireball");
    assert.throws(() => normalizeProvider({ id: "record", resource: "test", spells: [{ id: "x", label: "x", kind: "record", recordPath: "/MyMod/Spells/DA_Fireball.DA_Fireball" }] }), /reserved/);

    const savedAssignments: HmpSpellLoadoutAssignments = [
        ["native:Lumos", "native:Accio", null, "native:Incendio"],
        ["native:Levioso", "native:Confringo", "native:Disillusionment", null],
        [null, null, null, null],
        ["native:Reparo", null, null, null],
    ];

    const player = { id: 7, nickname: "Test", emitted: [] as Array<{ name: string; payload: unknown }>, emit(name: string, payload?: unknown) { this.emitted.push({ name, payload }); } };
    const metadata = new Map<string, unknown>();
    const emitted: Array<{ name: string; args: unknown[] }> = [];
    let activeCharacterId = 42;
    let hasActiveCharacter = true;
    let sessionReady = true;
    let effectiveCalls = 0;
    const core = {
        sessions: { isReady: () => sessionReady },
        characters: { active: () => hasActiveCharacter ? ({ id: activeCharacterId, accountId: 1, slot: 1, name: "Test", status: "active", createdAt: "", updatedAt: "", deletedAt: null }) : null },
        groups: { effective: async () => { effectiveCalls++; return [{ scope: "character", key: "job:auror", grade: 2, metadata: {} }]; } },
        metadata: {
            getCharacter: async (id: number, key: string) => metadata.get(`${id}:${key}`),
            setCharacter: async (id: number, key: string, value: unknown) => { metadata.set(`${id}:${key}`, value); return value; },
        },
    };
    const service = createSpellService({
        core: core as never,
        config: { command: "spells", enableCommands: true, adminGroups: [], rules, definitions: [], maxCastReportsPerSecond: 12 },
        players: () => [player], emit: (name, ...args) => emitted.push({ name, args }),
    });

    // hmp-core creates its session after an awaited database round-trip, so playerConnect and the
    // world-readiness events all beat it. Syncing then must be a quiet no-op, not a logged failure.
    sessionReady = false;
    const callsBeforeSession = effectiveCalls;
    assert.strictEqual(await service.policy.sync(player), null, "a session-less sync must not resolve a policy");
    assert.strictEqual(player.emitted.length, 0, "a session-less sync must not emit a policy");
    assert.strictEqual(await service.policy.syncAll(), 0, "syncAll must count only the players it actually synced");
    assert.strictEqual(effectiveCalls, callsBeforeSession, "a session-less sync must not reach hmp-core at all");
    sessionReady = true;
    assert.ok(await service.policy.sync(player), "the same sync resolves once the session is ready");
    assert.strictEqual(await service.policy.syncAll(), 1);

    assert.strictEqual(await service.grants.grant(player, "Incendio", { resource: "test" }), true);
    assert.deepStrictEqual(await service.grants.list(player), ["Spell_Incendio"]);
    assert.deepStrictEqual(metadata.get(`42:${METADATA_KEY}`), { version: 1, spells: ["Spell_Incendio"] });
    assert.strictEqual(await service.loadouts.set(player, 3, { resource: "test" }), true);
    assert.strictEqual(await service.loadouts.get(player), 3);
    assert.strictEqual(await service.loadouts.getAssignments(player), null);
    assert.strictEqual(await service.loadouts.setAssignments(player, savedAssignments, { resource: "test" }), true);
    assert.strictEqual(player.emitted.at(-1)?.name, "hmp-spells:policy");
    assert.deepStrictEqual(JSON.parse(String(player.emitted.at(-1)?.payload)).assignments, savedAssignments);
    assert.deepStrictEqual(await service.loadouts.getAssignments(player), savedAssignments);
    assert.deepStrictEqual(metadata.get(`42:${ASSIGNMENTS_METADATA_KEY}`), { version: 2, assignments: savedAssignments });
    const disposeProvider = service.providers.register(testProvider);
    assert.strictEqual(service.providers.resolve("kingsley:fireball")?.kind, "record");
    assert.strictEqual(await service.loadouts.setSlot(player, 0, 2, "kingsley:fireball", { resource: "test" }), true);
    assert.strictEqual((await service.loadouts.getAssignments(player))?.[0][2], "kingsley:fireball");
    assert.strictEqual(disposeProvider(), true);
    assert.strictEqual(await service.loadouts.setAssignments(player, savedAssignments), true);
    assert.strictEqual(await service.loadouts.setAssignments(player, savedAssignments), false);
    await assert.rejects(() => service.loadouts.setAssignments(player, [
        ["bad spell id", null, null, null], [null, null, null, null],
        [null, null, null, null], [null, null, null, null],
    ]), /four loadouts/);
    activeCharacterId = 43;
    assert.strictEqual(await service.loadouts.getAssignments(player), null);
    activeCharacterId = 42;
    assert.deepStrictEqual(await service.loadouts.getAssignments(player), savedAssignments);
    assert.strictEqual(await service.loadouts.unmanage(player), true);
    assert.strictEqual(await service.loadouts.get(player), null);
    // An unlock sticks on the client, so the pushed policy has to NAME the revoked lock; dropping it
    // from unlockSpells cannot take the spell back on its own.
    const pushed = () => JSON.parse(String(player.emitted.at(-1)?.payload));
    const grantedPolicy = pushed();
    assert.ok(grantedPolicy.unlockSpells.includes("Spell_Incendio"));
    assert.ok(!grantedPolicy.lockSpells.includes("Spell_Incendio"));
    assert.strictEqual(await service.grants.revoke(player, "Incendio"), true);
    const revokedPolicy = pushed();
    assert.ok(!revokedPolicy.unlockSpells.includes("Spell_Incendio"));
    assert.ok(revokedPolicy.lockSpells.includes("Spell_Incendio"), "a revoke must name the lock");
    await service.policy.sync(player);
    assert.ok(pushed().lockSpells.includes("Spell_Incendio"),
        "a revoke must keep being re-asserted on every sync, not fire once");
    assert.strictEqual(await service.grants.grant(player, "Incendio", { resource: "test" }), true);
    assert.ok(!pushed().lockSpells.includes("Spell_Incendio"), "re-granting must clear the revoke");
    assert.strictEqual(await service.grants.revoke(player, "Incendio"), true);
    assert.ok(emitted.some((event) => event.name === "hmp:spells:granted"));
    assert.ok(emitted.some((event) => event.name === "hmp:spells:revoked"));
    const dispose = service.rules.register({ id: "runtime", resource: "hmp-dueling", priority: 50, action: "allow", spells: ["Crucio"] });
    await service.rules.refresh();
    assert.ok((await service.policy.resolve(player)).policy.unlockSpells.includes("Spell_Crucio"));
    assert.strictEqual(dispose(), true);
    assert.strictEqual(service.rules.list().length, 0);
    assert.ok(player.emitted.some((event) => event.name === "hmp-spells:policy"));

    const policies: Array<{ ids: string[]; loadouts: number | undefined; relock: string[] | undefined }> = [];
    const serverEvents: Array<{ name: string; payload: unknown }> = [];
    const nativeAssignments: HmpSpellLoadoutAssignments = [
        [null, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
        [null, null, null, null],
    ];
    let activeLoadout = 0;
    let slotWrites = 0;
    const assignmentEventFlags: boolean[] = [];
    let assignmentListener: ((event: { source: "api" }) => boolean) | undefined;
    const recordCasts: string[] = [];
    const clientLogs: string[] = [];
    const client = createSpellClient({
        events: { emitServer: (name, payload) => serverEvents.push({ name, payload }) },
        spells: {
            setPolicy: (ids, loadouts, relock) => policies.push({ ids, loadouts, relock }),
            currentLoadout: () => activeLoadout,
            loadout: (index = activeLoadout) => ({ index, current: activeLoadout, source: "quick-actions", slots: [...nativeAssignments[index]] }),
            setLoadoutSlot: (slot, spellName, index = activeLoadout, emitAssignmentEvent = true) => {
                slotWrites++;
                assignmentEventFlags.push(emitAssignmentEvent);
                nativeAssignments[index][slot] = spellName;
                if (emitAssignmentEvent) assignmentListener?.({ source: "api" });
                return true;
            },
            cast: (slot) => ({ accepted: true, slot, spellName: "Lumos", reason: null }),
            castRecord: (path) => { recordCasts.push(path); return { accepted: true, slot: -1, spellName: path, reason: null }; },
        },
        log: (message) => clientLogs.push(message),
        debug: (message) => clientLogs.push(message),
    });
    assignmentListener = client.importNativeAssignments;
    assert.deepStrictEqual(serverEvents.map((event) => event.name), ["hmp-spells:ready"]);
    client.apply({ unlockSpells: ["Spell_Lumos", "invalid"], bonusLoadouts: 2, characterId: 42, assignments: savedAssignments, providers: [testProvider] });
    assert.deepStrictEqual(policies[0], { ids: ["Spell_Lumos"], loadouts: 2, relock: [] });
    assert.deepStrictEqual(nativeAssignments, [
        ["Lumos", "Accio", null, "Incendio"], ["Levioso", "Confringo", "Disillusionment", null],
        [null, null, null, null], ["Reparo", null, null, null],
    ]);
    assert.strictEqual(slotWrites, 16);
    assert.ok(assignmentEventFlags.every((flag) => !flag));
    assert.ok(clientLogs.some((message) => message.includes("loaded 7 Foundations assignment(s) for character 42")));
    assert.deepStrictEqual(serverEvents.map((event) => event.name), ["hmp-spells:ready"]);
    const serverUpdatedAssignments = cloneLoadoutAssignments(savedAssignments);
    serverUpdatedAssignments[2][1] = "native:Lumos";
    client.apply({ unlockSpells: ["Spell_Lumos"], bonusLoadouts: 2, characterId: 42, assignments: serverUpdatedAssignments, providers: [testProvider] });
    assert.strictEqual(assignmentEventFlags.slice(-16).filter(Boolean).length, 1);
    assert.strictEqual(client.loadout(2)?.slots[1], "native:Lumos");
    assert.deepStrictEqual(serverEvents.map((event) => event.name), ["hmp-spells:ready"]);
    nativeAssignments[0][1] = "Incendio"; // native mutation cannot overwrite Foundations state
    assert.strictEqual(client.loadout(0)?.slots[1], "native:Accio");
    activeLoadout = 1;
    assert.strictEqual(client.setLoadoutSlot(2, "native:Accio", 1), true);
    assert.strictEqual(assignmentEventFlags.at(-1), true);
    assert.strictEqual(JSON.parse(String(serverEvents.at(-1)?.payload)).assignments[1][2], "native:Accio");
    assert.strictEqual(client.loadout()?.slots[0], "native:Levioso");
    assert.strictEqual(client.cast(0).accepted, true);
    activeLoadout = 0;
    assert.strictEqual(client.setLoadoutSlot(0, "kingsley:fireball", 0), true);
    assert.strictEqual(assignmentEventFlags.at(-1), true);
    assert.strictEqual(nativeAssignments[0][0], null);
    nativeAssignments[0][3] = "Confringo";
    assert.strictEqual(client.importNativeAssignments({ source: "native-menu" }), true);
    assert.strictEqual(client.loadout(0)?.slots[0], "kingsley:fireball");
    assert.strictEqual(client.loadout(0)?.slots[3], "native:Confringo");
    const eventsBeforeCharacterSwitch = assignmentEventFlags.filter(Boolean).length;
    const assignmentsBeforeCharacterSwitch = client.status().assignments;
    client.apply({ unlockSpells: [], bonusLoadouts: null, characterId: 43, assignments: savedAssignments, providers: [testProvider] });
    assert.strictEqual(assignmentEventFlags.filter(Boolean).length, eventsBeforeCharacterSwitch);
    client.apply({ unlockSpells: ["Spell_Lumos"], bonusLoadouts: 2, characterId: 42, assignments: assignmentsBeforeCharacterSwitch, providers: [testProvider] });
    assert.strictEqual(client.cast(0).accepted, true);
    assert.deepStrictEqual(recordCasts, ["/MyMod/Spells/DA_Fireball.DA_Fireball"]);
    assert.strictEqual(recordCasts.length, 1, "restoration and native-menu imports must not cast records automatically");
    client.reportCast("/Game/Spells/Lumos/DA_LumosSpellRecord.DA_LumosSpellRecord");
    assert.strictEqual(JSON.parse(String(serverEvents.at(-1)?.payload)).name, "Lumos");

    // Reproduce Kingsley -> empty character -> Kingsley through both real services. Only the
    // game mutation/event is simulated here; this does not verify installation of the native hook.
    nativeAssignments[0][0] = "Expulso"; // Bombarda's native gameplay name
    assert.strictEqual(client.importNativeAssignments({ source: "native-menu" }), true);
    const submission = JSON.parse(String(serverEvents.at(-1)?.payload));
    assert.strictEqual(submission.characterId, 42);
    assert.strictEqual(submission.assignments[0][0], "native:Expulso");
    const repliesBeforeSave = player.emitted.length;
    const writesBeforeSave = slotWrites;
    const policyWritesBeforeSave = policies.length;
    await service.acceptClientAssignments(player, submission.assignments);
    assert.strictEqual(player.emitted.length, repliesBeforeSave, "client assignment save must not echo a policy/slot replay");
    assert.strictEqual(emitted.at(-1)?.name, "hmp:spells:assignments", "other server resources still receive the assignment event");
    client.acknowledgeAssignments(submission);
    assert.strictEqual(slotWrites, writesBeforeSave, "saving a native menu assignment must not rewrite any slots");
    assert.strictEqual(policies.length, policyWritesBeforeSave, "saving a native menu assignment must not reapply unlock policy");
    assert.strictEqual(client.status().assignmentsDirty, false);
    const storedKingsley = JSON.stringify(metadata.get(`42:${ASSIGNMENTS_METADATA_KEY}`));
    const submissionsBeforeSwitch = serverEvents.filter((event) => event.name === "hmp-spells:assignments").length;
    activeCharacterId = 43;
    await service.policy.sync(player);
    client.apply(player.emitted.at(-1)?.payload);
    assert.ok(nativeAssignments.flat().every((spell) => spell === null));
    assert.strictEqual(JSON.stringify(metadata.get(`42:${ASSIGNMENTS_METADATA_KEY}`)), storedKingsley);
    assert.strictEqual(metadata.has(`43:${ASSIGNMENTS_METADATA_KEY}`), false);
    activeCharacterId = 42;
    // Only a spell the character is allowed comes back to the bar; a revoked one stays hidden.
    await service.grants.grant(player, "Expulso", { resource: "test" });
    await service.policy.sync(player);
    client.apply(player.emitted.at(-1)?.payload);
    assert.strictEqual(nativeAssignments[0][0], "Expulso");
    assert.strictEqual(client.loadout(0)?.slots[0], "native:Expulso");
    assert.strictEqual(serverEvents.filter((event) => event.name === "hmp-spells:assignments").length, submissionsBeforeSwitch);

    // Counts must cross the same server-policy -> client boundary as assignments. No configured
    // count rule: four loadouts -> unset character (one) -> original character (four).
    const countRules: HmpSpellRule[] = [];
    const counts = createSpellService({
        core: core as never,
        config: { command: "spells", enableCommands: true, adminGroups: [], rules: countRules, definitions: [], maxCastReportsPerSecond: 12 },
        players: () => [player],
    });
    await counts.loadouts.set(player, 3);
    client.apply(player.emitted.at(-1)?.payload);
    assert.strictEqual(policies.at(-1)?.loadouts, 3);
    const originalEntitlements = JSON.stringify(metadata.get(`42:${METADATA_KEY}`));
    activeCharacterId = 43;
    await counts.policy.sync(player);
    client.apply(player.emitted.at(-1)?.payload);
    assert.strictEqual(policies.at(-1)?.loadouts, 0, "unset active character must have one base loadout, not inherit native perks");
    assert.strictEqual(await counts.loadouts.get(player), null, "default must not create an explicit character override");
    assert.strictEqual(metadata.has(`43:${METADATA_KEY}`), false);
    assert.strictEqual(JSON.stringify(metadata.get(`42:${METADATA_KEY}`)), originalEntitlements);
    activeCharacterId = 42;
    await counts.policy.sync(player);
    client.apply(player.emitted.at(-1)?.payload);
    assert.strictEqual(policies.at(-1)?.loadouts, 3);
    countRules.push(normalizeRule({ id: "bonus", resource: "test", priority: 1000, action: "allow", bonusLoadouts: 2 }, 0));
    assert.strictEqual((await counts.policy.resolve(player)).policy.bonusLoadouts, 3, "character override wins over rules");
    await counts.loadouts.set(player, 0);
    assert.strictEqual((await counts.policy.resolve(player)).policy.bonusLoadouts, 0, "explicit zero also wins over rules");
    await counts.loadouts.unmanage(player);
    assert.strictEqual((await counts.policy.resolve(player)).policy.bonusLoadouts, 2, "clearing override falls back to rules");
    countRules.length = 0;
    await counts.policy.sync(player);
    client.apply(player.emitted.at(-1)?.payload);
    assert.strictEqual(policies.at(-1)?.loadouts, 0, "without a rule, clearing override falls back to one base loadout");
    hasActiveCharacter = false;
    await counts.policy.sync(player);
    client.apply(player.emitted.at(-1)?.payload);
    assert.strictEqual(policies.at(-1)?.loadouts, -1, "no active character retains the unmanaged lifecycle state");
    hasActiveCharacter = true;
    counts.stop();

    // Server-defined spells join the catalog, the policy's lock table, grants, rules and slots by id.
    assert.throws(() => normalizeDefinition({ id: "Fs", base: "Confringo" }, "definition", "test"), /3-32 characters/);
    assert.throws(() => normalizeDefinition({ id: "Bombarda", base: "Confringo" }, "definition", "test"), /already names a spell/, "a game name would resolve to Spell_Expulso");
    assert.throws(() => normalizeDefinition({ id: "Firestorm", base: "Confringo", stats: { damage: "40" } }, "definition", "test"), /finite numbers/);
    const host = fakeHost();
    host.define({ id: "Mend", base: "Depulso" }); // another resource's, straight through the host
    const definedRules: HmpSpellRule[] = [];
    const defined = createSpellService({
        core: core as never,
        config: { command: "spells", enableCommands: true, adminGroups: [], rules: definedRules, definitions: [], maxCastReportsPerSecond: 12 },
        definitions: host,
        players: () => [player],
    });
    activeCharacterId = 44;
    const definedPolicy = async () => (await defined.policy.resolve(player)).policy;
    assert.strictEqual(defined.definitions.supported(), true);
    const disposeFirestorm = defined.definitions.register({ id: "Firestorm", resource: "hmp-quests", base: "Confringo", stats: { damage: 40 } });
    assert.throws(() => defined.definitions.register({ id: "firestorm", resource: "other", base: "Glacius" }), /already defined by 'hmp-quests'/);
    assert.throws(() => defined.definitions.register({ id: "Mend", resource: "other", base: "Glacius" }), /already defined$/, "a spell defined outside hmp-spells is not taken over");
    assert.throws(() => defined.definitions.register({ id: "Icebolt", resource: "other", base: "Typo" }), /not a player spell/);
    assert.strictEqual(defined.catalog.resolve("firestorm"), "Spell_Firestorm");
    assert.strictEqual(defined.catalog.resolve("Mend"), "Spell_Mend");
    assert.ok(defined.catalog.list("fire").some((spell) => spell.name === "Firestorm"));
    assert.deepStrictEqual(defined.definitions.list("hmp-quests").map((definition) => definition.id), ["Firestorm"]);
    assert.strictEqual(defined.definitions.get("MEND")?.resource, null);
    assert.ok((await definedPolicy()).lockSpells.includes("Spell_Firestorm"), "a defined spell starts locked, like a fresh character's");
    assert.strictEqual(await defined.grants.grant(player, "firestorm"), true);
    assert.deepStrictEqual(await defined.grants.list(player), ["Spell_Firestorm"]);
    assert.ok((await definedPolicy()).unlockSpells.includes("Spell_Firestorm"));
    assert.strictEqual(await defined.grants.revoke(player, "Firestorm"), true);
    assert.ok((await definedPolicy()).lockSpells.includes("Spell_Firestorm"), "a revoke must name a defined spell's lock too");
    const disposeAuror = defined.rules.register({ id: "auror-fire", resource: "hmp-ministry", priority: 500, action: "allow", spells: ["Firestorm"], match: { groups: [{ key: "job:auror", minimumGrade: 2 }] } });
    assert.ok((await definedPolicy()).unlockSpells.includes("Spell_Firestorm"), "a group rule takes a defined spell by id");
    disposeAuror();
    definedRules.push(normalizeRule({ id: "all", resource: "test", priority: 1000, action: "allow", spells: "*" }, 0));
    assert.ok((await definedPolicy()).unlockSpells.includes("Spell_Mend"), "'*' covers every defined spell");
    definedRules.length = 0;
    assert.strictEqual(await defined.loadouts.setSlot(player, 0, 0, "Firestorm"), true);
    assert.strictEqual((await defined.loadouts.getAssignments(player))?.[0][0], "native:Firestorm", "a defined spell slots by its id");
    assert.strictEqual(disposeFirestorm(), true);
    assert.strictEqual(disposeFirestorm(), false);
    assert.strictEqual(defined.catalog.resolve("Firestorm"), null);
    assert.ok((await definedPolicy()).lockSpells.includes("Spell_Firestorm"), "connected clients keep a removed spell, so it stays re-locked");
    defined.definitions.register({ id: "Frostfire", resource: "hmp-quests", base: "Confringo", parts: { onHit: "Glacius" } });
    assert.strictEqual(defined.definitions.clear("hmp-quests"), 1);
    defined.definitions.register({ id: "Icebolt", resource: "hmp-spells", base: "Glacius" });
    assert.strictEqual(defined.status().definitions, 1);
    defined.stop();
    assert.deepStrictEqual(host.removed, ["Firestorm", "Frostfire", "Icebolt"], "stopping removes what hmp-spells defined, never another resource's");
    assert.ok(host.get("Mend"));
    // A host without Spells.define keeps the game's own spells and refuses a definition.
    const older = createSpellService({
        core: core as never,
        config: { command: "spells", enableCommands: true, adminGroups: [], rules: [], definitions: [], maxCastReportsPerSecond: 12 },
        players: () => [player],
    });
    assert.strictEqual(older.definitions.supported(), false);
    assert.throws(() => older.definitions.register({ id: "Firestorm", resource: "x", base: "Confringo" }), /need a HogwartsMP host with Spells\.define/);
    assert.deepStrictEqual(older.definitions.list(), []);
    assert.strictEqual(older.catalog.resolve("Firestorm"), null);
    older.stop();
    activeCharacterId = 42;

    // Modded gameplay names use the same native diamond and persist without a vanilla whitelist.
    const moddedName = `MyMod_${"A".repeat(94)}`;
    const nativeProvider = normalizeProvider({
        id: "my-mod", resource: "my-mod",
        spells: [{ id: "shield", label: "Shield", kind: "native", nativeName: moddedName }],
    });
    const moddedAssignments: HmpSpellLoadoutAssignments = [
        ["my-mod:shield", `native:${moddedName}`, null, null], [null, null, null, null],
        [null, null, null, null], [null, null, null, null],
    ];
    client.apply({ characterId: 42, assignments: moddedAssignments, providers: [nativeProvider] });
    assert.deepStrictEqual(nativeAssignments[0], [moddedName, moddedName, null, null]);
    assert.strictEqual(client.importNativeAssignments({ source: "native-menu" }), true);
    assert.strictEqual(client.loadout(0)?.slots[0], "my-mod:shield", "unchanged native cells retain named provider identities");
    const recordCastsBeforeRestore = recordCasts.length;
    client.apply({ characterId: 43, assignments: null });
    assert.ok(nativeAssignments.flat().every((spell) => spell === null));
    client.apply({ characterId: 42, assignments: moddedAssignments, providers: [nativeProvider] });
    assert.deepStrictEqual(nativeAssignments[0], [moddedName, moddedName, null, null]);
    assert.strictEqual(recordCasts.length, recordCastsBeforeRestore, "native modded spells must not use the record-casting workaround");
    client.apply({ characterId: 42, assignments: moddedAssignments, providers: [nativeProvider], lockSpells: ["Spell_Incendio", "bogus"] });
    assert.deepStrictEqual(policies.at(-1)?.relock, ["Spell_Incendio"], "revoked locks must reach the native enforcer, filtered");
    client.apply({ characterId: 42, assignments: moddedAssignments, providers: [nativeProvider] });
    assert.deepStrictEqual(policies.at(-1)?.relock, [], "a policy with no lockSpells must clear the revoke list, not keep the last one");

    // A revoke empties the spell's quick slots at once but keeps it saved, so lifting it restores them.
    const slotted: HmpSpellLoadoutAssignments = [
        ["native:Lumos", "native:Expulso", null, "native:Expulso"], [null, null, null, null],
        [null, null, null, null], ["native:Expulso", null, null, null],
    ];
    const allowExpulso = { characterId: 42, unlockSpells: ["Spell_Lumos", "Spell_Expulso"], assignments: slotted };
    client.apply(allowExpulso);
    assert.deepStrictEqual(nativeAssignments[0], ["Lumos", "Expulso", null, "Expulso"]);
    client.apply({ characterId: 42, unlockSpells: ["Spell_Lumos"], lockSpells: ["Spell_Expulso"], assignments: slotted });
    assert.deepStrictEqual(nativeAssignments[0], ["Lumos", null, null, null], "a revoked spell must leave every quick slot");
    assert.strictEqual(nativeAssignments[3][0], null, "a revoke must reach inactive loadouts too");
    assert.deepStrictEqual(client.loadout(0)?.slots, slotted[0], "the saved bar keeps a revoked spell");
    assert.strictEqual(client.importNativeAssignments({ source: "native-menu" }), true);
    assert.deepStrictEqual(client.loadout(0)?.slots, slotted[0], "a hidden cell must not import as a player clear");
    assert.strictEqual(client.setLoadoutSlot(2, "native:Expulso", 0), false, "a revoked spell cannot be slotted");
    assert.strictEqual(client.cast(1).accepted, false, "a hidden revoked spell cannot be cast by slot");
    client.apply(allowExpulso);
    assert.deepStrictEqual(nativeAssignments[0], ["Lumos", "Expulso", null, "Expulso"], "lifting the revoke restores its slots");
    assert.strictEqual(nativeAssignments[3][0], "Expulso");
    // A defined spell is outside the client catalog; its slot name and Spell_<id> lock still pair up.
    const definedSlots: HmpSpellLoadoutAssignments = [["native:Firestorm", null, null, null], [null, null, null, null], [null, null, null, null], [null, null, null, null]];
    client.apply({ characterId: 42, unlockSpells: ["Spell_Firestorm"], assignments: definedSlots });
    assert.strictEqual(nativeAssignments[0][0], "Firestorm");
    client.apply({ characterId: 42, lockSpells: ["Spell_Firestorm"], assignments: definedSlots });
    assert.strictEqual(nativeAssignments[0][0], null, "a revoked defined spell must leave its quick slots");
    assert.strictEqual(client.setLoadoutSlot(1, "Firestorm", 0), false);
    client.stop();
    assert.deepStrictEqual(policies.at(-1), { ids: [], loadouts: -1, relock: [] });
}

run().then(() => console.log("hmp-spells tests passed"));
