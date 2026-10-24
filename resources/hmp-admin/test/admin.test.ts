import assert = require("node:assert");
import { test } from "node:test";
import configModule = require("../server/config");
import permissionsModule = require("../server/permissions");
import serviceModule = require("../server/service");
import uiModule = require("../server/ui");
import type { HmpAdminAuditEntry, HmpAdminBan, HmpAdminWarning } from "../types";
import type { AdminConfig, AdminRepository, Player } from "../server/internal";

const { loadConfig } = configModule;
const { createPermissions } = permissionsModule;
const { createAdminService } = serviceModule;
const { inventoryOptions, inventoryItemField, spellOptions, transmogOptions, weatherOptions, WEATHER_PROFILES } = uiModule;

test("offers every known weather profile and preserves custom configured values", () => {
    assert.strictEqual(WEATHER_PROFILES.length, 34);
    assert.strictEqual(new Set(WEATHER_PROFILES).size, WEATHER_PROFILES.length);
    assert.ok(WEATHER_PROFILES.includes("Clear"));
    assert.ok(WEATHER_PROFILES.includes("LightRain_01"));
    assert.ok(WEATHER_PROFILES.includes("SnowShort"));
    const options = weatherOptions("CustomLive", "CustomBaseline");
    assert.deepStrictEqual(options.slice(0, 2), [
        { label: "CustomLive", value: "CustomLive", description: "Current" },
        { label: "CustomBaseline", value: "CustomBaseline", description: "Configured baseline" },
    ]);
    assert.strictEqual(options.length, 36);
});

test("builds searchable administration choices from canonical inventory definitions", () => {
    const inventory = {
        items: {
            list: () => [
                { name: "sealed_letter", label: "Sealed Letter", category: "Documents", resource: "test" },
                { name: "native:broomhouse", aliases: ["native:house_broom"], label: "Broom House", nativeId: "BroomHouse", native: true, category: "Broom", holder: "BroomStorage", resource: "hmp-inventory" },
            ],
        },
    } as never;
    const options = inventoryOptions(inventory);
    assert.deepStrictEqual(options[0], { label: "Broom House · BroomHouse", value: "native:broomhouse", description: "Native · Broom · BroomStorage" });
    assert.strictEqual(options[1].value, "sealed_letter");
    assert.deepStrictEqual(inventoryOptions(inventory, "BroomHouse"), [options[0]]);
    assert.deepStrictEqual(inventoryOptions(inventory, "house_broom"), [options[0]]);
    assert.deepStrictEqual(inventoryOptions(inventory, "documents sealed"), [options[1]]);
    assert.deepStrictEqual(inventoryItemField(inventoryOptions(inventory, "BroomHouse"), "BroomHouse"), {
        name: "item", label: "Item", type: "select", searchable: true, required: true,
        default: "native:broomhouse",
        placeholder: "Filter matching items…",
        description: "1 match for 'BroomHouse'. Best match selected.",
        options: [options[0]],
    });
});

test("builds spell choices around the character's current personal grants", () => {
    const definitions = [
        { name: "Accio", lockId: "Spell_Accio" },
        { name: "Incendio", lockId: "Spell_Incendio" },
        { name: "Levioso", lockId: "Spell_Levioso" },
    ];
    const spells = {
        catalog: {
            list: (query = "") => definitions.filter((spell) => `${spell.name} ${spell.lockId}`.toLowerCase().includes(query.toLowerCase())),
            get: (value: string) => definitions.find((spell) => spell.name.toLowerCase() === value.toLowerCase() || spell.lockId.toLowerCase() === value.toLowerCase()) || null,
        },
    } as never;
    assert.deepStrictEqual(spellOptions(spells, "lev", ["Spell_Accio"], "grant"), [{ label: "Levioso", value: "Spell_Levioso", description: "Spell_Levioso" }]);
    assert.deepStrictEqual(spellOptions(spells, "acc", ["Spell_Accio"], "revoke"), [{ label: "Accio", value: "Spell_Accio", description: "Spell_Accio · Personally granted" }]);
    assert.deepStrictEqual(spellOptions(spells, "acc", ["Spell_Accio"], "grant"), []);
});

test("builds searchable transmog choices with friendly labels and exact native ids", () => {
    assert.deepStrictEqual(transmogOptions(["MirabelGarlick", "EleazarFig", "EleazarFig"], "EleazarFig"), [
        { label: "Eleazar Fig", value: "EleazarFig", description: "EleazarFig · Current" },
        { label: "Mirabel Garlick", value: "MirabelGarlick", description: "MirabelGarlick" },
    ]);
});

function setup(overrides: Partial<AdminConfig> = {}) {
    let nextAudit = 1;
    let nextWarning = 1;
    let nextBan = 1;
    let nextTeleport = 1;
    const audit: HmpAdminAuditEntry[] = [];
    const warnings: HmpAdminWarning[] = [];
    const bans: HmpAdminBan[] = [];
    const inventoryMutations: unknown[][] = [];
    const groupMutations: unknown[][] = [];
    const jobMutations: unknown[][] = [];
    const bankMutations: unknown[][] = [];
    const spellMutations: unknown[][] = [];
    const transmogMutations: unknown[][] = [];
    const environmentMutations: unknown[][] = [];
    const personalSpells = new Map<number, Set<string>>();
    const characterTransmogs = new Map<number, string>();
    const kicked = new Map<number, string>();
    const holds = new Map<number, Set<string>>();
    const emitted = new Map<number, Array<{ event: string; payload: unknown }>>();
    const visibility = new Map<number, boolean>();

    function player(id: number, nickname: string): Player {
        return {
            id, nickname, connected: true, ping: id * 5, position: { x: id * 100, y: id * 200, z: 300 }, virtualWorld: 0,
            emit(event, payload) {
                if (!emitted.has(id)) emitted.set(id, []);
                emitted.get(id)!.push({ event, payload });
            },
            location() { return { areaId: "Hogwarts", regionId: "LibraryAnnex", destinationId: null, x: this.position.x, y: this.position.y, z: this.position.z, yaw: 0, revision: 1 }; },
            kick(reason = "") { kicked.set(id, reason); },
            teleport() { return nextTeleport++; },
            hold(input) {
                // Mirrors the host binding, which throws rather than returning false.
                const extra = input as { rigid?: boolean; anchorId?: number };
                if (extra.rigid && !extra.anchorId) throw new TypeError("hold(options).rigid needs an anchorId — there is nothing to attach to");
                if (!holds.has(id)) holds.set(id, new Set());
                holds.get(id)!.add(input.owner);
                return true;
            },
            release(owner) { return holds.get(id)?.delete(owner) || false; },
            holds() { return [...holds.get(id) || []].map((owner) => ({ owner })); },
            setVisible(visible: boolean) { visibility.set(id, visible); },
        } as Player;
    }

    const verifiedAdmin = player(1, "Minerva");
    const assertedAdmin = player(2, "Temporary Staff");
    const verifiedTarget = player(3, "Harry");
    const assertedTarget = player(4, "Guest");
    const players = [verifiedAdmin, assertedAdmin, verifiedTarget, assertedTarget];
    const sessions = new Map(players.map((entry) => [entry.id, {
        player: entry, playerId: entry.id,
        account: { id: entry.id * 10, displayName: entry.nickname, createdAt: new Date(0), lastSeenAt: new Date(0) },
        principal: { provider: "test", subject: `subject-${entry.id}`, trust: entry === assertedAdmin || entry === assertedTarget ? "asserted" : "verified" },
        character: { id: entry.id * 100, accountId: entry.id * 10, slot: 1, name: entry.nickname, status: "active", createdAt: new Date(0), updatedAt: new Date(0), deletedAt: null },
        connectedAt: new Date(0).toISOString(),
    }]));
    // hmp-core group rows, keyed "<scope>:<ownerId>:<group>".
    const groupRows = new Map<string, number>([[`account:${verifiedAdmin.id * 10}:admin`, 3], [`account:${assertedAdmin.id * 10}:admin`, 3]]);
    function listGroups(scope: "account" | "character", ownerId: number) {
        const prefix = `${scope}:${ownerId}:`;
        return [...groupRows].filter(([row]) => row.startsWith(prefix)).map(([row, grade]) => ({ scope, key: row.slice(prefix.length), grade, metadata: {} }));
    }
    function connect(id: number, nickname: string, accountId: number): Player {
        const entry = player(id, nickname);
        players.push(entry);
        sessions.set(id, {
            player: entry, playerId: id,
            account: { id: accountId, displayName: nickname, createdAt: new Date(0), lastSeenAt: new Date(0) },
            principal: { provider: "test", subject: `subject-${accountId}`, trust: "verified" },
            character: { id: id * 100, accountId, slot: 2, name: nickname, status: "active", createdAt: new Date(0), updatedAt: new Date(0), deletedAt: null },
            connectedAt: new Date(0).toISOString(),
        });
        return entry;
    }

    const core = {
        sessions: { get(value: Player | number) { return sessions.get(typeof value === "number" ? value : value.id) || null; }, all: () => [...sessions.values()] },
        groups: {
            async listAccount(accountId: number) { return listGroups("account", accountId); },
            async listCharacter(characterId: number) { return listGroups("character", characterId); },
            // Mirrors hmp-core: the active character's row wins over the account's when its grade is not lower.
            async effective(value: Player | number) {
                const current = sessions.get(typeof value === "number" ? value : value.id)!;
                const merged = new Map(listGroups("account", current.account.id).map((group) => [group.key, group]));
                for (const group of current.character ? listGroups("character", current.character.id) : []) if (group.grade >= (merged.get(group.key)?.grade ?? -Infinity)) merged.set(group.key, group);
                return [...merged.values()];
            },
            async setAccount(...args: unknown[]) { groupMutations.push(["setAccount", ...args]); groupRows.set(`account:${args[0]}:${args[1]}`, Number(args[2])); return { scope: "account", key: String(args[1]), grade: Number(args[2]), metadata: {} }; },
            async removeAccount(...args: unknown[]) { groupMutations.push(["removeAccount", ...args]); return groupRows.delete(`account:${args[0]}:${args[1]}`); },
            async setCharacter(...args: unknown[]) { groupMutations.push(["setCharacter", ...args]); groupRows.set(`character:${args[0]}:${args[1]}`, Number(args[2])); return { scope: "character", key: String(args[1]), grade: Number(args[2]), metadata: {} }; },
            async removeCharacter(...args: unknown[]) { groupMutations.push(["removeCharacter", ...args]); return groupRows.delete(`character:${args[0]}:${args[1]}`); },
        },
    };

    const repository: AdminRepository = {
        async start() {},
        async beginAudit(input) {
            const id = nextAudit++;
            audit.push({ id, actorAccountId: input.actor?.account.id ?? null, actorCharacterId: input.actor?.character?.id ?? null, actorPlayerId: input.actor?.playerId ?? null, action: input.action, targetAccountId: input.target?.account.id ?? null, targetCharacterId: input.target?.character?.id ?? null, targetPlayerId: input.target?.playerId ?? null, reason: input.reason, metadata: input.metadata || {}, status: "pending", error: "", createdAt: new Date(), completedAt: null });
            return id;
        },
        async finishAudit(id, status, error = "", metadata) { const entry = audit.find((value) => value.id === id)!; entry.status = status; entry.error = error; entry.completedAt = new Date(); if (metadata) entry.metadata = metadata; },
        async audit(limit, targetAccountId) { return audit.filter((entry) => !targetAccountId || entry.targetAccountId === targetAccountId).slice(-limit).reverse(); },
        async addWarning(accountId, actorAccountId, reason) { const warning = { id: nextWarning++, accountId, actorAccountId, reason, createdAt: new Date() }; warnings.push(warning); return warning; },
        async warnings(accountId, limit) { return warnings.filter((entry) => entry.accountId === accountId).slice(-limit).reverse(); },
        async addBan(input) { const ban = { id: nextBan++, accountId: input.accountId, provider: input.provider, subject: input.subject, trust: input.trust, actorAccountId: input.actorAccountId, reason: input.reason, expiresAt: input.expiresAt, createdAt: new Date(), revokedAt: null }; bans.push(ban); return ban; },
        async activeBan(session) { return bans.find((entry) => !entry.revokedAt && entry.accountId === session.account.id) || null; },
        async revokeBan(id) { const ban = bans.find((entry) => entry.id === id && !entry.revokedAt); if (!ban) return false; ban.revokedAt = new Date(); return true; },
        async bans(limit) { return bans.slice(-limit).reverse(); },
    };

    const config: AdminConfig = {
        command: "admin", requireVerifiedIdentity: true, allowUnsafeAssertedBans: false, teleportTimeoutMs: 5000, auditPageSize: 50,
        noclip: { speed: 4500, boost: 3, slow: 0.25, tickMs: 11, hideLocal: true, movement: { forward: "w", back: "s", left: "a", right: "d", up: "space", down: "ctrl", boost: "shift", slow: "alt" } },
        bootstrapSecret: "closed-test-secret", roleRules: [
            { group: "admin", minimumGrade: 1, capabilities: ["admin.view", "admin.kick", "admin.teleport", "admin.freeze", "admin.warn", "admin.noclip"] },
            { group: "admin", minimumGrade: 2, capabilities: ["admin.groups", "admin.jobs", "admin.inventory", "admin.appearance", "admin.spells", "admin.banking", "admin.treasury", "admin.audit", "admin.environment"] },
            { group: "admin", minimumGrade: 3, capabilities: ["admin.ban", "admin.reconcile"] },
        ],
        protectedGroups: [],
        ...overrides,
    };
    const permissions = createPermissions({ core: core as never, config });
    const banking = {
        accounts: { async personal(characterId: number, currency: string) { return { id: characterId, currency }; } },
        transactions: {
            async credit(...args: unknown[]) { bankMutations.push(["credit", ...args]); return {}; },
            async debit(...args: unknown[]) { bankMutations.push(["debit", ...args]); return {}; },
            async reconcile(...args: unknown[]) { bankMutations.push(["reconcile", ...args]); return {}; },
        },
    };
    const spellDefinitions = [
        { name: "Accio", lockId: "Spell_Accio" },
        { name: "Incendio", lockId: "Spell_Incendio" },
        { name: "Levioso", lockId: "Spell_Levioso" },
    ];
    const resolveSpell = (value: string) => spellDefinitions.find((spell) => spell.name.toLowerCase() === value.toLowerCase() || spell.lockId.toLowerCase() === value.toLowerCase())?.lockId || null;
    const spells = {
        catalog: {
            resolve: resolveSpell,
            get(value: string) { const lockId = resolveSpell(value); return lockId ? spellDefinitions.find((spell) => spell.lockId === lockId) || null : null; },
            list(query = "") { return spellDefinitions.filter((spell) => `${spell.name} ${spell.lockId}`.toLowerCase().includes(query.toLowerCase())); },
        },
        grants: {
            async list(value: Player) { return [...personalSpells.get(value.id) || []]; },
            async grant(value: Player, spell: string, context?: unknown) {
                if (!personalSpells.has(value.id)) personalSpells.set(value.id, new Set());
                const grants = personalSpells.get(value.id)!;
                if (grants.has(spell)) return false;
                grants.add(spell);
                spellMutations.push(["grant", value.id, spell, context]);
                return true;
            },
            async revoke(value: Player, spell: string, context?: unknown) {
                const grants = personalSpells.get(value.id);
                if (!grants?.delete(spell)) return false;
                spellMutations.push(["revoke", value.id, spell, context]);
                return true;
            },
        },
    };
    const environmentBaseline = {
        weather: "Clear", time: { hour: 9, minute: 0, second: 0, scale: 1 },
        date: { day: 1, month: 9, year: 0 }, season: "autumn" as const,
    };
    let environmentState = {
        weather: "Clear", hour: 9, minute: 0, second: 0, day: 1, month: 9, year: 0,
        season: 2 as 0 | 1 | 2 | 3, timeScale: 1, revision: 1,
    };
    const world = {
        environment: {
            baseline: () => ({ ...environmentBaseline, time: { ...environmentBaseline.time }, date: { ...environmentBaseline.date } }),
            state: () => ({ ...environmentState }),
            reset() {
                environmentMutations.push(["reset"]);
                environmentState = { weather: "Clear", hour: 9, minute: 0, second: 0, day: 1, month: 9, year: 0, season: 2, timeScale: 1, revision: environmentState.revision + 1 };
                return { ...environmentState };
            },
            setWeather(weather: string) { environmentMutations.push(["weather", weather]); environmentState.weather = weather; environmentState.revision++; return true; },
            setTime(hour: number, minute: number, second = 0) { environmentMutations.push(["time", hour, minute, second]); Object.assign(environmentState, { hour, minute, second }); environmentState.revision++; return true; },
            setDate(day: number, month: number, year = 0) { environmentMutations.push(["date", day, month, year]); Object.assign(environmentState, { day, month, year }); environmentState.revision++; return true; },
            setSeason(season: "spring" | "summer" | "autumn" | "winter" | 0 | 1 | 2 | 3) { environmentMutations.push(["season", season]); environmentState.season = typeof season === "number" ? season : ({ spring: 0, summer: 1, autumn: 2, winter: 3 } as const)[season]; environmentState.revision++; return true; },
            setTimeScale(scale: number) { environmentMutations.push(["scale", scale]); environmentState.timeScale = scale; environmentState.revision++; return true; },
        },
    };
    const characters = {
        appearance: {
            async getTransmog(value: Player) { return characterTransmogs.get(value.id) || ""; },
            listTransmogs: () => ["EleazarFig", "MirabelGarlick"],
            async setTransmog(value: Player, transmog: string) {
                const changed = characterTransmogs.get(value.id) !== transmog;
                characterTransmogs.set(value.id, transmog);
                transmogMutations.push(["set", value.id, transmog]);
                return changed;
            },
            async clearTransmog(value: Player) {
                const changed = characterTransmogs.delete(value.id);
                transmogMutations.push(["clear", value.id]);
                return changed;
            },
        },
    };
    const service = createAdminService({
        repository, permissions, core: core as never,
        inventory: { inventory: { async add(...args: unknown[]) { inventoryMutations.push(["add", ...args]); return 5; }, async remove(...args: unknown[]) { inventoryMutations.push(["remove", ...args]); return 4; } } } as never,
        banking: banking as never,
        characters: characters as never,
        jobs: { employment: { async hire(...args: unknown[]) { jobMutations.push(["hire", ...args]); return {}; }, async fire(...args: unknown[]) { jobMutations.push(["fire", ...args]); return {}; }, async setGrade(...args: unknown[]) { jobMutations.push(["grade", ...args]); return {}; } } } as never,
        spells: spells as never,
        world: world as never,
        config, logger: { debug: () => true, info: () => true, warn: () => true, error: () => true }, migrations: [],
        listPlayers: () => players, getPlayer: (id) => players.find((entry) => entry.id === id) || null,
    });
    return { service, permissions, config, connect, verifiedAdmin, assertedAdmin, verifiedTarget, assertedTarget, audit, warnings, bans, kicked, holds, emitted, visibility, groupRows, inventoryMutations, groupMutations, jobMutations, bankMutations, spellMutations, transmogMutations, environmentMutations };
}

test("requires verified staff identity but supports session-only closed-test bootstrap", async () => {
    const state = setup();
    await state.service.ready();
    assert.strictEqual(await state.permissions.has(state.assertedAdmin, "admin.view"), false);
    assert.strictEqual(await state.permissions.authenticate(state.assertedAdmin, "wrong"), false);
    assert.strictEqual(await state.permissions.authenticate(state.assertedAdmin, "closed-test-secret"), true);
    assert.strictEqual(await state.permissions.has(state.assertedAdmin, "admin.ban"), true);
    assert.strictEqual(state.permissions.revoke(state.assertedAdmin), true);
    assert.strictEqual(await state.permissions.has(state.assertedAdmin, "admin.view"), false);
    assert.deepStrictEqual(await state.permissions.capabilities(state.verifiedAdmin), ["admin.appearance", "admin.audit", "admin.ban", "admin.banking", "admin.environment", "admin.freeze", "admin.groups", "admin.inventory", "admin.jobs", "admin.kick", "admin.noclip", "admin.reconcile", "admin.spells", "admin.teleport", "admin.treasury", "admin.view", "admin.warn"]);
});

test("changes and resets the global environment with validation and audit", async () => {
    const state = setup();
    assert.strictEqual((await state.service.actions.environment.state(state.verifiedAdmin))?.weather, "Clear");
    assert.strictEqual((await state.service.actions.environment.baseline(state.verifiedAdmin)).time.hour, 9);
    assert.strictEqual(await state.service.actions.environment.weather(state.verifiedAdmin, "LightRain_01", "rain test"), true);
    assert.strictEqual(await state.service.actions.environment.time(state.verifiedAdmin, 17, 30, 5), true);
    assert.strictEqual(await state.service.actions.environment.date(state.verifiedAdmin, 29, 2, 1891, "leap-day test"), true);
    assert.strictEqual(await state.service.actions.environment.season(state.verifiedAdmin, "winter"), true);
    assert.strictEqual(await state.service.actions.environment.timeScale(state.verifiedAdmin, 0), true);
    await assert.rejects(state.service.actions.environment.time(state.verifiedAdmin, 24, 0), /hour must be an integer from 0 to 23/);
    await assert.rejects(state.service.actions.environment.date(state.verifiedAdmin, 31, 4), /day must be an integer from 1 to 30/);
    await assert.rejects(state.service.actions.environment.season(state.verifiedAdmin, "monsoon" as never), /season must be spring, summer, autumn, or winter/);
    assert.strictEqual((await state.service.actions.environment.reset(state.verifiedAdmin))?.weather, "Clear");
    assert.deepStrictEqual(state.environmentMutations, [
        ["weather", "LightRain_01"], ["time", 17, 30, 5], ["date", 29, 2, 1891], ["season", "winter"], ["scale", 0], ["reset"],
    ]);
    assert.deepStrictEqual(state.audit.map((entry) => entry.action), [
        "environment.weather", "environment.time", "environment.date", "environment.season", "environment.time-scale", "environment.reset",
    ]);
    assert.ok(state.audit.every((entry) => entry.status === "completed"));
});

test("loads no-clip slow movement and local hiding with safe defaults", () => {
    const Hmp = { config: { load: (_path: string, options: { defaults: unknown }) => structuredClone(options.defaults), env: { boolean: (_value: unknown, fallback: boolean) => fallback } } };
    const defaults = loadConfig(Hmp as never, { env: {} }).noclip;
    assert.strictEqual(defaults.slow, 0.25);
    assert.strictEqual(defaults.hideLocal, false);
    assert.strictEqual(defaults.movement.slow, "alt");

    const overrides = { config: { ...Hmp.config, load: () => ({ roleRules: [], noclip: { slow: 0.001, hideLocal: true, movement: { slow: "lalt" } } }) } };
    const tuned = loadConfig(overrides as never, { env: {} }).noclip;
    assert.strictEqual(tuned.slow, 0.05);
    assert.strictEqual(tuned.hideLocal, true);
    assert.strictEqual(tuned.movement.slow, "lalt");
    assert.strictEqual(tuned.movement.boost, "shift");
    assert.strictEqual(loadConfig({ config: { ...Hmp.config, load: () => ({ roleRules: [], noclip: { slow: 4 } }) } } as never, { env: {} }).noclip.slow, 1);
});

test("toggles and revokes audited administrator no-clip", async () => {
    const state = setup();
    assert.strictEqual(state.service.noclip.isActive(state.verifiedAdmin), false);
    assert.strictEqual(await state.service.actions.noclip(state.verifiedAdmin), true);
    assert.strictEqual(state.service.status().activeNoclip, 1);
    assert.strictEqual(state.service.noclip.isActive(state.verifiedAdmin), true);
    assert.strictEqual(state.service.noclip.isActive(state.verifiedAdmin.id), true);
    assert.strictEqual(state.service.noclip.isActive(state.verifiedTarget), false);
    const enabled = state.emitted.get(state.verifiedAdmin.id)![0];
    assert.strictEqual(enabled.event, "hmp-admin:noclip");
    assert.deepStrictEqual(JSON.parse(String(enabled.payload)), { enabled: true, ...state.config.noclip });
    assert.strictEqual(state.visibility.get(state.verifiedAdmin.id), false);

    assert.strictEqual(await state.service.actions.noclip(state.verifiedAdmin), false);
    assert.strictEqual(state.service.status().activeNoclip, 0);
    assert.strictEqual(state.service.noclip.isActive(state.verifiedAdmin), false);
    assert.strictEqual(state.visibility.get(state.verifiedAdmin.id), true);
    assert.deepStrictEqual(state.audit.map((entry) => entry.action), ["player.noclip.enable", "player.noclip.disable"]);

    await state.service.actions.noclip(state.verifiedAdmin);
    state.groupRows.delete("account:10:admin");
    assert.strictEqual(await state.service.revalidateNoclip(), 1);
    assert.strictEqual(state.service.status().activeNoclip, 0);
    assert.strictEqual(state.service.noclip.isActive(state.verifiedAdmin.id), false);
    assert.strictEqual(state.visibility.get(state.verifiedAdmin.id), true);
    assert.deepStrictEqual(JSON.parse(String(state.emitted.get(state.verifiedAdmin.id)!.at(-1)!.payload)), { enabled: false });

    state.groupRows.set("account:10:admin", 3);
    await state.service.actions.noclip(state.verifiedAdmin);
    assert.strictEqual(state.service.noclip.isActive(state.verifiedAdmin), true);
    state.service.disconnect(state.verifiedAdmin);
    assert.strictEqual(state.service.noclip.isActive(state.verifiedAdmin), false);
});

test("inspects, freezes, warns, kicks, and audits player actions", async () => {
    const state = setup();
    const listed = await state.service.players.list(state.verifiedAdmin);
    assert.strictEqual(listed.length, 4);
    assert.strictEqual(listed[0].location?.areaId, "Hogwarts");
    assert.strictEqual(await state.service.actions.freeze(state.verifiedAdmin, state.verifiedTarget, "investigation"), true);
    assert.strictEqual((await state.service.players.get(state.verifiedAdmin, state.verifiedTarget)).frozen, true);
    assert.strictEqual(await state.service.actions.release(state.verifiedAdmin, state.verifiedTarget, "clear"), true);
    assert.strictEqual((await state.service.players.get(state.verifiedAdmin, state.verifiedTarget)).frozen, false);
    assert.deepStrictEqual(state.emitted.get(state.verifiedTarget.id)?.filter((entry) => entry.event === "hmp-admin:freeze").map((entry) => JSON.parse(String(entry.payload)).frozen), [true, false]);
    await state.service.moderation.warn(state.verifiedAdmin, state.verifiedTarget, "Please stop");
    await state.service.actions.kick(state.verifiedAdmin, state.verifiedTarget, "Testing kick");
    assert.strictEqual(state.warnings.length, 1);
    assert.strictEqual(state.kicked.get(state.verifiedTarget.id), "Testing kick");
    assert.ok(state.audit.every((entry) => entry.status === "completed"));
    assert.deepStrictEqual(state.audit.map((entry) => entry.action), ["player.freeze", "player.release", "moderation.warn", "player.kick"]);
});

test("restores a frozen player's input when the host ends the hold and releases holds on stop", async () => {
    const state = setup();
    const freezeCommands = () => state.emitted.get(state.verifiedTarget.id)?.filter((entry) => entry.event === "hmp-admin:freeze").map((entry) => JSON.parse(String(entry.payload)).frozen);
    await state.service.actions.freeze(state.verifiedAdmin, state.verifiedTarget, "investigation");
    assert.strictEqual(state.service.onHoldEnded(state.verifiedTarget, "rp-custody", "expired"), false);
    assert.strictEqual(state.service.onHoldEnded(state.verifiedTarget, "hmp-admin", "expired"), true);
    assert.deepStrictEqual(freezeCommands(), [true, false]);
    state.service.onHoldEnded(state.verifiedTarget, "hmp-admin", "disconnect");
    assert.deepStrictEqual(freezeCommands(), [true, false], "a disconnected client has nothing to restore");
    await state.service.actions.freeze(state.verifiedAdmin, state.verifiedTarget, "investigation");
    await state.service.stop();
    assert.strictEqual(state.holds.get(state.verifiedTarget.id)?.has("hmp-admin"), false);
});

test("revives only a dead player and reports a host that cannot", async () => {
    const state = setup();
    const { verifiedAdmin: admin, verifiedTarget: target } = state;
    let dead = false;
    let accepted = true;
    const revives: unknown[] = [];
    target.isDead = () => dead;
    await assert.rejects(state.service.actions.revive(admin, target), { code: "HMP_ADMIN_NOT_DEAD" });
    assert.strictEqual((await state.service.players.get(admin, target)).dead, false);
    dead = true;
    assert.strictEqual((await state.service.players.get(admin, target)).dead, true);
    await assert.rejects(state.service.actions.revive(admin, target), { code: "HMP_ADMIN_ACTION_UNAVAILABLE" }, "a host without player.revive");
    target.revive = (options) => { revives.push(options); return accepted; };
    await assert.rejects(state.service.actions.revive(state.assertedAdmin, target), { code: "HMP_ADMIN_FORBIDDEN" });
    assert.strictEqual(await state.service.actions.revive(admin, target), true);
    accepted = false;
    await assert.rejects(state.service.actions.revive(admin, target), { code: "HMP_ADMIN_REVIVE_REJECTED" }, "a respawn already on its way");
    assert.deepStrictEqual(revives, [undefined, undefined], "full health, the host's default");
    assert.deepStrictEqual(state.audit.map((entry) => [entry.action, entry.status]), [["player.revive", "failed"], ["player.revive", "completed"], ["player.revive", "failed"]]);
});

test("takes a player out of player collision and puts them back", async () => {
    const state = setup();
    const { verifiedAdmin: admin, verifiedTarget: target } = state;
    assert.strictEqual((await state.service.players.get(admin, target)).collidable, null, "a host without player.isCollidable hides the toggle");
    await assert.rejects(state.service.actions.collision(admin, target, false), { code: "HMP_ADMIN_ACTION_UNAVAILABLE" }, "a host without player.setCollidable");
    let collidable = true;
    target.isCollidable = () => collidable;
    target.setCollidable = (value) => { collidable = value; };
    assert.strictEqual((await state.service.players.get(admin, target)).collidable, true);
    await assert.rejects(state.service.actions.collision(admin, target, "off" as never), /collidable must be true or false/);
    await assert.rejects(state.service.actions.collision(state.assertedAdmin, target, false), { code: "HMP_ADMIN_FORBIDDEN" });
    assert.strictEqual(await state.service.actions.collision(admin, target, false), false);
    assert.strictEqual((await state.service.players.get(admin, target)).collidable, false);
    assert.strictEqual(await state.service.actions.collision(admin, target, true), true);
    assert.strictEqual(collidable, true);
    assert.deepStrictEqual(state.audit.map((entry) => [entry.action, entry.status, entry.metadata]), [
        ["player.collision.disable", "failed", { collidable: false }],
        ["player.collision.disable", "completed", { collidable: false }],
        ["player.collision.enable", "completed", { collidable: true }],
    ]);
});

test("waits for matching player-local streamed teleport completion", async () => {
    const state = setup();
    const first = state.service.actions.goto(state.verifiedAdmin, state.verifiedTarget);
    const second = state.service.actions.bring(state.verifiedAdmin, state.assertedTarget);
    while (state.service.status().pendingTeleports < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(state.service.onTeleportComplete(state.verifiedAdmin, 1, 0, { requestId: 1, status: 0, requested: { x: 0, y: 0, z: 0, yaw: null, snapToGround: true, groundSnapDistance: 2000 }, destination: { x: 1, y: 2, z: 3, yaw: 0 }, groundSnapped: true }), true);
    assert.strictEqual(state.service.onTeleportComplete(state.assertedTarget, 2, 0, { requestId: 2, status: 0, requested: { x: 0, y: 0, z: 0, yaw: null, snapToGround: true, groundSnapDistance: 2000 }, destination: { x: 1, y: 2, z: 3, yaw: 0 }, groundSnapped: true }), true);
    assert.strictEqual(await first, 1);
    assert.strictEqual(await second, 2);
});

test("sends a player to a map or intro place and reports how the travel ended", async () => {
    const state = setup();
    const { verifiedAdmin: admin, verifiedTarget: target } = state;
    const DUNGEON = "/Game/Environment/Azkaban/Maps/Azkaban_Dungeon";
    const OVERLAND = "/Game/Levels/Overland/Overland";
    await assert.rejects(state.service.actions.travel(admin, target, { map: OVERLAND }), { code: "HMP_ADMIN_ACTION_UNAVAILABLE" }, "a host without player.travelToMap");
    const requests: unknown[][] = [];
    let nextRequest = 1;
    target.travelToMap = (map, options) => { requests.push([map, options]); return nextRequest++; };
    await assert.rejects(state.service.actions.travel(admin, target, { place: "intro.vault" }), { code: "HMP_ADMIN_ACTION_UNAVAILABLE" }, "a host without player.travelToPlace");
    target.travelToPlace = (name) => { requests.push([name]); return nextRequest++; };
    await assert.rejects(state.service.actions.travel(admin, target, { place: "hogsmeade" as never }), /place must be one of/);
    await assert.rejects(state.service.actions.travel(admin, target, { map: " " }), /map must be a package path/);
    await assert.rejects(state.service.actions.travel(state.assertedAdmin, target, { map: OVERLAND }), { code: "HMP_ADMIN_FORBIDDEN" });

    const sent = async (count: number) => { while (requests.length < count) await new Promise<void>((resolve) => setImmediate(resolve)); return nextRequest - 1; };
    const ended = (requestId: number, status: number, areaId: string | null) => ({ requestId, status, map: "", place: null, areaId, destination: status === 0 || status === 6 ? { x: 1, y: 2, z: 3, yaw: 0 } : null });
    const dungeon = state.service.actions.travel(admin, target, { map: DUNGEON });
    const first = await sent(1);
    assert.strictEqual(state.service.onMapTravelComplete(admin, first, 0, ended(first, 0, "Azkaban_Dungeon")), false, "another player's request");
    assert.strictEqual(state.service.onMapTravelComplete(target, first, 0, ended(first, 0, "Azkaban_Dungeon")), true);
    assert.strictEqual((await dungeon).areaId, "Azkaban_Dungeon");

    const missing = state.service.actions.travel(admin, target, { map: OVERLAND, playerStart: "Sil_LondonDungeon_DungeonMap" });
    const second = await sent(2);
    state.service.onMapTravelComplete(target, second, 3, ended(second, 3, null));
    await assert.rejects(missing, { code: "HMP_ADMIN_TRAVEL_FAILED", message: /does not have that map installed/ });

    const vault = state.service.actions.travel(admin, target, { place: "intro.vault" });
    const third = await sent(3);
    state.service.onMapTravelComplete(target, third, 6, ended(third, 6, "Intro_Vault_Render"));
    assert.strictEqual((await vault).status, 6, "arrived without an extra level still arrives");

    const interrupted = state.service.actions.travel(admin, target, { place: "intro.cliffside" });
    await sent(4);
    state.service.disconnect(target);
    await assert.rejects(interrupted, { code: "HMP_ADMIN_PLAYER_DISCONNECTED" });
    target.travelToPlace = () => 0;
    await assert.rejects(state.service.actions.travel(admin, target, { place: "intro.gringotts" }), { code: "HMP_ADMIN_TRAVEL_REJECTED" });

    assert.deepStrictEqual(requests, [[DUNGEON, undefined], [OVERLAND, { playerStart: "Sil_LondonDungeon_DungeonMap" }], ["intro.vault"], ["intro.cliffside"]]);
    assert.deepStrictEqual(state.audit.map((entry) => [entry.metadata, entry.status]), [
        [{ map: OVERLAND, playerStart: "" }, "failed"], [{ place: "intro.vault" }, "failed"],
        [{ map: DUNGEON, playerStart: "" }, "completed"], [{ map: OVERLAND, playerStart: "Sil_LondonDungeon_DungeonMap" }, "failed"],
        [{ place: "intro.vault" }, "completed"], [{ place: "intro.cliffside" }, "failed"], [{ place: "intro.gringotts" }, "failed"],
    ]);
    assert.ok(state.audit.every((entry) => entry.action === "player.travel"));
});

test("walks a player to the admin or after them, stops it, and routes each end to the admin who started it", async () => {
    const state = setup();
    const { verifiedAdmin: admin, verifiedTarget: target } = state;
    await assert.rejects(state.service.actions.walkTo(admin, target), { code: "HMP_ADMIN_ACTION_UNAVAILABLE" }, "a host without player.moveTo");
    await assert.rejects(state.service.actions.follow(admin, target), { code: "HMP_ADMIN_ACTION_UNAVAILABLE" }, "a host without player.follow");
    await assert.rejects(state.service.actions.stopMoving(admin, target), { code: "HMP_ADMIN_ACTION_UNAVAILABLE" }, "a host without player.stopMoving");

    let drive: { owner: string; mode: "to" | "follow" } | null = null;
    let live = true;
    const calls: unknown[][] = [];
    target.moveTo = (x, y, z, options) => { calls.push(["moveTo", x, y, z, options]); if (live) drive = { owner: options.owner, mode: "to" }; return live; };
    target.follow = (leader, options) => { calls.push(["follow", leader, options]); if (live) drive = { owner: options.owner, mode: "follow" }; return live; };
    target.stopMoving = (owner) => { calls.push(["stopMoving", owner]); const stopped = Boolean(drive && (!owner || drive.owner === owner)); if (stopped) drive = null; return stopped; };
    target.moving = () => drive && { ...drive, gait: "walk", speed: null, radius: 150, expiresAt: 0 };

    await assert.rejects(state.service.actions.walkTo(admin, admin), { code: "HMP_ADMIN_SELF_TARGET" });
    await assert.rejects(state.service.actions.follow(state.assertedAdmin, target), { code: "HMP_ADMIN_FORBIDDEN" });
    assert.strictEqual(await state.service.actions.walkTo(admin, target), true);
    assert.deepStrictEqual(calls.at(-1), ["moveTo", 100, 200, 300, { owner: "hmp-admin#1", acceptRadius: 150 }], "to where the admin stands");
    assert.strictEqual((await state.service.players.get(admin, target)).moving, "to");
    assert.strictEqual(state.service.onMoveEnded("rp-escort#1"), null, "another resource's walk");
    assert.deepStrictEqual(state.service.onMoveEnded("hmp-admin#1"), { actor: admin, mode: "to" });
    assert.strictEqual(state.service.onMoveEnded("hmp-admin#1"), null, "each end is reported once");

    assert.strictEqual(await state.service.actions.follow(admin, target), true);
    assert.deepStrictEqual(calls.at(-1), ["follow", admin, { owner: "hmp-admin#2" }]);
    assert.strictEqual((await state.service.players.get(admin, target)).moving, "follow");
    assert.strictEqual(await state.service.actions.walkTo(admin, target), true);
    assert.strictEqual(state.service.onMoveEnded("hmp-admin#2"), null, "a follow the admin replaced is not reported as ended");
    assert.strictEqual(await state.service.actions.stopMoving(admin, target), true);
    assert.deepStrictEqual(calls.at(-1), ["stopMoving", "hmp-admin#3"]);
    assert.strictEqual(state.service.onMoveEnded("hmp-admin#3"), null, "a walk the admin stopped is not reported again");
    assert.strictEqual((await state.service.players.get(admin, target)).moving, null);
    await assert.rejects(state.service.actions.stopMoving(admin, target), { code: "HMP_ADMIN_NOT_MOVING" });

    drive = { owner: "rp-escort#7", mode: "to" };
    await assert.rejects(state.service.actions.stopMoving(admin, target), { code: "HMP_ADMIN_NOT_MOVING" }, "another resource's walk is left alone");
    assert.strictEqual((await state.service.players.get(admin, target)).moving, null);
    live = false;
    drive = null;
    await assert.rejects(state.service.actions.follow(admin, target), { code: "HMP_ADMIN_MOVE_REJECTED" });
    assert.strictEqual(state.service.onMoveEnded("hmp-admin#4"), null);

    live = true;
    await state.service.actions.follow(admin, target);
    await state.service.stop();
    assert.deepStrictEqual(calls.at(-1), ["stopMoving", "hmp-admin#5"], "stopping hmp-admin ends its walks");
    assert.strictEqual(state.service.onMoveEnded("hmp-admin#5"), null);
    assert.deepStrictEqual(state.audit.map((entry) => [entry.action, entry.status]), [
        ["player.walk-to", "failed"], ["player.follow", "failed"], ["player.stop-moving", "failed"],
        ["player.walk-to", "completed"], ["player.follow", "completed"], ["player.walk-to", "completed"], ["player.stop-moving", "completed"],
        ["player.stop-moving", "failed"], ["player.stop-moving", "failed"], ["player.follow", "failed"], ["player.follow", "completed"],
    ]);
});

test("rejects administrative teleports across coordinate spaces", async () => {
    const state = setup();
    state.verifiedTarget.location = () => ({ areaId: "Overland", regionId: "Hogsmeade", destinationId: null, x: 0, y: 0, z: 0, yaw: 0, revision: 2 });
    await assert.rejects(state.service.actions.goto(state.verifiedAdmin, state.verifiedTarget), /same game area/);
    assert.strictEqual(state.service.status().pendingTeleports, 0);
});

test("routes corrective mutations through foundations services with completed audit", async () => {
    const state = setup();
    await state.service.actions.inventory(state.verifiedAdmin, state.verifiedTarget, "give", "native:back_001_common", 2);
    await state.service.actions.group(state.verifiedAdmin, state.verifiedTarget, "set", "character", "prefect", 1, "promotion");
    await state.service.actions.job(state.verifiedAdmin, state.verifiedTarget, "hire", "auror", 2, "test employment");
    await state.service.actions.banking(state.verifiedAdmin, state.verifiedTarget, "credit", 50, "galleons", "test funds");
    await state.service.actions.reconcile(state.verifiedAdmin, "tx:test", "fail", "closed-test recovery");
    assert.strictEqual(state.inventoryMutations.length, 1);
    assert.deepStrictEqual(state.inventoryMutations[0], ["add", state.verifiedTarget, "native:back_001_common", 2, { identified: true }]);
    assert.strictEqual(state.groupMutations.length, 1);
    assert.strictEqual(state.jobMutations.length, 1);
    assert.strictEqual(state.bankMutations.length, 2);
    assert.strictEqual(state.audit[0].reason, "inventory.give");
    assert.ok(state.audit.every((entry) => entry.status === "completed"));
});

const SELF = { code: "HMP_ADMIN_SELF_TARGET" };
const HIERARCHY = { code: "HMP_ADMIN_GRADE_HIERARCHY" };

test("keeps a staff grade change below the acting administrator's own grade", async () => {
    const state = setup();
    const { verifiedAdmin: senior, verifiedTarget: staff, assertedTarget: guest } = state;
    // A grade-2 admin through their character, which still grants admin.groups.
    state.groupRows.set("character:300:admin", 2);
    const sameAccount = state.connect(5, "Harry's alt", 30);
    const owner = state.connect(6, "Albus", 60);
    state.groupRows.set("character:600:admin", 4);
    const admin = (actor: Player, target: Player, operation: "set" | "remove", scope: "account" | "character", grade = 0) =>
        state.service.actions.group(actor, target, operation, scope, "admin", grade, "test");

    await assert.rejects(admin(staff, staff, "set", "account", 3), SELF);
    await assert.rejects(admin(staff, staff, "set", "character", 99), SELF);
    await assert.rejects(admin(staff, sameAccount, "set", "character", 1), SELF, "another character on the same account");
    await assert.rejects(admin(staff, guest, "set", "account", 2), HIERARCHY, "their own grade");
    await assert.rejects(admin(staff, guest, "set", "character", 4), HIERARCHY, "above their own grade");
    await assert.rejects(admin(staff, senior, "set", "account", 1), HIERARCHY, "demoting a superior");
    await assert.rejects(admin(staff, senior, "remove", "account"), HIERARCHY, "removing a superior");
    await assert.rejects(admin(senior, owner, "remove", "account"), HIERARCHY, "a superior's character grade counts on either scope");
    assert.strictEqual(state.groupMutations.length, 0);
    assert.ok(state.audit.every((entry) => entry.status === "failed"), "refused attempts stay in the audit trail");

    assert.strictEqual(await admin(staff, guest, "set", "character", 1), true);
    assert.strictEqual(await admin(staff, guest, "remove", "character"), true);
    assert.strictEqual(await state.service.actions.group(staff, staff, "set", "character", "prefect", 9, "not a staff group"), true);
    assert.strictEqual(await admin(senior, staff, "set", "character", 1), true);
    assert.strictEqual(await admin(senior, staff, "remove", "character"), true);
    assert.deepStrictEqual(state.groupMutations.map((entry) => entry.slice(0, 4)), [
        ["setCharacter", 400, "admin", 1], ["removeCharacter", 400, "admin"],
        ["setCharacter", 300, "prefect", 9],
        ["setCharacter", 300, "admin", 1], ["removeCharacter", 300, "admin"],
    ]);
});

test("holds role-rule groups and configured protected groups to the staff hierarchy", async () => {
    const state = setup({ protectedGroups: ["staff"] });
    state.config.roleRules.push({ group: "Moderator", minimumGrade: 1, capabilities: ["admin.view"] });
    const { verifiedAdmin: senior, verifiedTarget: target } = state;
    await assert.rejects(state.service.actions.group(senior, target, "set", "character", "moderator", 1, "no moderator grade"), HIERARCHY);
    await assert.rejects(state.service.actions.group(senior, target, "set", "account", " STAFF ", 0, "no staff grade"), HIERARCHY);
    assert.strictEqual(state.groupMutations.length, 0);
    const Hmp = { config: { load: () => ({ roleRules: [], protectedGroups: [" Staff ", ""] }), env: { boolean: (_value: unknown, fallback: boolean) => fallback } } };
    assert.deepStrictEqual(loadConfig(Hmp as never, { env: {} }).protectedGroups, ["staff"]);
    assert.throws(() => loadConfig({ config: { ...Hmp.config, load: () => ({ roleRules: [], protectedGroups: "staff" }) } } as never, { env: {} }), /protectedGroups must be an array/);
});

test("lets a bootstrapped owner assign any staff grade, their own included", async () => {
    const state = setup();
    state.groupRows.delete("account:20:admin");
    assert.strictEqual(await state.permissions.authenticate(state.assertedAdmin, "closed-test-secret"), true);
    assert.strictEqual(await state.service.actions.group(state.assertedAdmin, state.assertedAdmin, "set", "account", "admin", 5, "provision owner"), true);
    assert.strictEqual(await state.service.actions.group(state.assertedAdmin, state.verifiedAdmin, "set", "account", "admin", 5, "second owner"), true);
    assert.strictEqual(state.groupRows.get("account:20:admin"), 5);
    assert.strictEqual(state.groupRows.get("account:10:admin"), 5);
});

test("applies a demotion queued ahead of the demoted admin's own group change", async () => {
    const state = setup();
    state.groupRows.set("account:30:admin", 2);
    const demotion = state.service.actions.group(state.verifiedAdmin, state.verifiedTarget, "remove", "account", "admin", 0, "demoted");
    const grant = state.service.actions.group(state.verifiedTarget, state.assertedTarget, "set", "account", "admin", 1, "raced grant");
    assert.strictEqual(await demotion, true);
    await assert.rejects(grant, { code: "HMP_ADMIN_FORBIDDEN" });
    assert.strictEqual(state.groupRows.has("account:40:admin"), false);
});

test("sets and unsets a connected character's persistent transmog with audit", async () => {
    const state = setup();
    await assert.rejects(() => state.service.actions.transmog(state.assertedAdmin, state.verifiedTarget, "set", "EleazarFig"), /permission/);
    assert.strictEqual(state.transmogMutations.length, 0);
    assert.deepStrictEqual(await state.service.actions.transmogs(state.verifiedAdmin), ["EleazarFig", "MirabelGarlick"]);
    assert.strictEqual(await state.service.actions.transmogCurrent(state.verifiedAdmin, state.verifiedTarget), "");
    assert.strictEqual(await state.service.actions.transmog(state.verifiedAdmin, state.verifiedTarget, "set", "EleazarFig", "disguise test"), true);
    assert.strictEqual(await state.service.actions.transmogCurrent(state.verifiedAdmin, state.verifiedTarget), "EleazarFig");
    assert.strictEqual(await state.service.actions.transmog(state.verifiedAdmin, state.verifiedTarget, "unset", "", "restore appearance"), true);
    assert.deepStrictEqual(state.transmogMutations, [
        ["set", state.verifiedTarget.id, "EleazarFig"],
        ["clear", state.verifiedTarget.id],
    ]);
    assert.deepStrictEqual(state.audit.map((entry) => [entry.action, entry.metadata]), [
        ["appearance.transmog.set", { previous: "", transmog: "EleazarFig" }],
        ["appearance.transmog.unset", { previous: "EleazarFig", transmog: "" }],
    ]);
    assert.ok(state.audit.every((entry) => entry.status === "completed"));
});

test("grants and revokes canonical personal spells with actor context and audit", async () => {
    const state = setup();
    assert.deepStrictEqual(await state.service.actions.spellGrants(state.verifiedAdmin, state.verifiedTarget), []);
    assert.strictEqual(await state.service.actions.spell(state.verifiedAdmin, state.verifiedTarget, "grant", "Incendio", "completed class"), true);
    assert.strictEqual(await state.service.actions.spell(state.verifiedAdmin, state.verifiedTarget, "grant", "Spell_Incendio", "duplicate check"), false);
    assert.deepStrictEqual(await state.service.actions.spellGrants(state.verifiedAdmin, state.verifiedTarget), ["Spell_Incendio"]);
    assert.strictEqual(await state.service.actions.spell(state.verifiedAdmin, state.verifiedTarget, "revoke", "Incendio", "corrected grant"), true);
    assert.strictEqual(await state.service.actions.spell(state.verifiedAdmin, state.verifiedTarget, "revoke", "Incendio", "duplicate check"), false);
    await assert.rejects(state.service.actions.spell(state.verifiedAdmin, state.verifiedTarget, "grant", "NotASpell", "invalid"), /Unknown spell/);
    assert.deepStrictEqual(state.spellMutations.map((entry) => entry.slice(0, 3)), [
        ["grant", state.verifiedTarget.id, "Spell_Incendio"],
        ["revoke", state.verifiedTarget.id, "Spell_Incendio"],
    ]);
    const grantContext = state.spellMutations[0][3] as { resource: string; actor: Player; reason: string };
    assert.strictEqual(grantContext.resource, "hmp-admin");
    assert.strictEqual(grantContext.actor, state.verifiedAdmin);
    assert.strictEqual(grantContext.reason, "completed class");
    assert.deepStrictEqual(state.audit.map((entry) => entry.action), ["spells.grant", "spells.grant", "spells.revoke", "spells.revoke"]);
    assert.ok(state.audit.every((entry) => entry.status === "completed"));
    assert.deepStrictEqual(state.audit[0].metadata, { spell: "Spell_Incendio", name: "Incendio" });
});

test("refuses durable bans for asserted identities and enforces verified bans on session ready", async () => {
    const state = setup();
    await assert.rejects(state.service.moderation.ban(state.verifiedAdmin, state.assertedTarget, "untrusted identity"), /verified target identity/);
    const ban = await state.service.moderation.ban(state.verifiedAdmin, state.verifiedTarget, "verified identity", 24);
    assert.strictEqual(ban.trust, "verified");
    assert.match(state.kicked.get(state.verifiedTarget.id) || "", /Banned/);
    state.kicked.delete(state.verifiedTarget.id);
    const session = { player: state.verifiedTarget, playerId: state.verifiedTarget.id, account: { id: 30 }, principal: { provider: "test", subject: "subject-3", trust: "verified" }, character: null } as never;
    assert.strictEqual(await state.service.onSessionReady(session), true);
    assert.match(state.kicked.get(state.verifiedTarget.id) || "", /Banned/);
    assert.strictEqual(await state.service.moderation.unban(state.verifiedAdmin, ban.id, "reviewed"), true);
});
