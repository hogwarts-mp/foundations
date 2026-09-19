import assert = require("node:assert");
import { test } from "node:test";
import permissionsModule = require("../server/permissions");
import serviceModule = require("../server/service");
import uiModule = require("../server/ui");
import type { HmpAdminAuditEntry, HmpAdminBan, HmpAdminWarning } from "../types";
import type { AdminConfig, AdminRepository, Player } from "../server/internal";

const { createPermissions } = permissionsModule;
const { createAdminService } = serviceModule;
const { inventoryOptions, spellOptions } = uiModule;

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

function setup() {
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
    const personalSpells = new Map<number, Set<string>>();
    const kicked = new Map<number, string>();
    const holds = new Map<number, Set<string>>();
    const emitted = new Map<number, Array<{ event: string; payload: unknown }>>();

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
            hold(input) { if (!holds.has(id)) holds.set(id, new Set()); holds.get(id)!.add(input.owner); return true; },
            release(owner) { return holds.get(id)?.delete(owner) || false; },
            holds() { return [...holds.get(id) || []].map((owner) => ({ owner })); },
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
    const groupGrades = new Map<number, number>([[verifiedAdmin.id, 3], [assertedAdmin.id, 3]]);

    const core = {
        sessions: { get(value: Player | number) { return sessions.get(typeof value === "number" ? value : value.id) || null; }, all: () => [...sessions.values()] },
        groups: {
            async effective(value: Player | number) { const id = typeof value === "number" ? value : value.id; const grade = groupGrades.get(id); return grade === undefined ? [] : [{ scope: "account", key: "admin", grade, metadata: {} }]; },
            async setAccount(...args: unknown[]) { groupMutations.push(["setAccount", ...args]); return { scope: "account", key: String(args[1]), grade: Number(args[2]), metadata: {} }; },
            async removeAccount(...args: unknown[]) { groupMutations.push(["removeAccount", ...args]); return true; },
            async setCharacter(...args: unknown[]) { groupMutations.push(["setCharacter", ...args]); return { scope: "character", key: String(args[1]), grade: Number(args[2]), metadata: {} }; },
            async removeCharacter(...args: unknown[]) { groupMutations.push(["removeCharacter", ...args]); return true; },
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
        noclip: { speed: 4500, boost: 3, tickMs: 11, movement: { forward: "w", back: "s", left: "a", right: "d", up: "space", down: "ctrl", boost: "shift" } },
        bootstrapSecret: "closed-test-secret", roleRules: [
            { group: "admin", minimumGrade: 1, capabilities: ["admin.view", "admin.kick", "admin.teleport", "admin.freeze", "admin.warn", "admin.noclip"] },
            { group: "admin", minimumGrade: 2, capabilities: ["admin.groups", "admin.jobs", "admin.inventory", "admin.spells", "admin.banking", "admin.audit"] },
            { group: "admin", minimumGrade: 3, capabilities: ["admin.ban", "admin.reconcile"] },
        ],
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
    const service = createAdminService({
        repository, permissions, core: core as never,
        inventory: { inventory: { async add(...args: unknown[]) { inventoryMutations.push(["add", ...args]); return 5; }, async remove(...args: unknown[]) { inventoryMutations.push(["remove", ...args]); return 4; } } } as never,
        banking: banking as never,
        jobs: { employment: { async hire(...args: unknown[]) { jobMutations.push(["hire", ...args]); return {}; }, async fire(...args: unknown[]) { jobMutations.push(["fire", ...args]); return {}; }, async setGrade(...args: unknown[]) { jobMutations.push(["grade", ...args]); return {}; } } } as never,
        spells: spells as never,
        config, logger: { debug: () => true, info: () => true, warn: () => true, error: () => true }, migrations: [],
        listPlayers: () => players, getPlayer: (id) => players.find((entry) => entry.id === id) || null,
    });
    return { service, permissions, config, verifiedAdmin, assertedAdmin, verifiedTarget, assertedTarget, audit, warnings, bans, kicked, holds, emitted, groupGrades, inventoryMutations, groupMutations, jobMutations, bankMutations, spellMutations };
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
    assert.deepStrictEqual(await state.permissions.capabilities(state.verifiedAdmin), ["admin.audit", "admin.ban", "admin.banking", "admin.freeze", "admin.groups", "admin.inventory", "admin.jobs", "admin.kick", "admin.noclip", "admin.reconcile", "admin.spells", "admin.teleport", "admin.view", "admin.warn"]);
});

test("toggles and revokes audited administrator no-clip", async () => {
    const state = setup();
    assert.strictEqual(await state.service.actions.noclip(state.verifiedAdmin), true);
    assert.strictEqual(state.service.status().activeNoclip, 1);
    const enabled = state.emitted.get(state.verifiedAdmin.id)![0];
    assert.strictEqual(enabled.event, "hmp-admin:noclip");
    assert.deepStrictEqual(JSON.parse(String(enabled.payload)), { enabled: true, ...state.config.noclip });

    assert.strictEqual(await state.service.actions.noclip(state.verifiedAdmin), false);
    assert.strictEqual(state.service.status().activeNoclip, 0);
    assert.deepStrictEqual(state.audit.map((entry) => entry.action), ["player.noclip.enable", "player.noclip.disable"]);

    await state.service.actions.noclip(state.verifiedAdmin);
    state.groupGrades.delete(state.verifiedAdmin.id);
    assert.strictEqual(await state.service.revalidateNoclip(), 1);
    assert.strictEqual(state.service.status().activeNoclip, 0);
    assert.deepStrictEqual(JSON.parse(String(state.emitted.get(state.verifiedAdmin.id)!.at(-1)!.payload)), { enabled: false });
});

test("inspects, freezes, warns, kicks, and audits player actions", async () => {
    const state = setup();
    const listed = await state.service.players.list(state.verifiedAdmin);
    assert.strictEqual(listed.length, 4);
    assert.strictEqual(listed[0].location?.areaId, "Hogwarts");
    assert.strictEqual(await state.service.actions.freeze(state.verifiedAdmin, state.verifiedTarget, "investigation"), true);
    assert.strictEqual((await state.service.players.get(state.verifiedAdmin, state.verifiedTarget)).frozen, true);
    assert.strictEqual(await state.service.actions.release(state.verifiedAdmin, state.verifiedTarget, "clear"), true);
    await state.service.moderation.warn(state.verifiedAdmin, state.verifiedTarget, "Please stop");
    await state.service.actions.kick(state.verifiedAdmin, state.verifiedTarget, "Testing kick");
    assert.strictEqual(state.warnings.length, 1);
    assert.strictEqual(state.kicked.get(state.verifiedTarget.id), "Testing kick");
    assert.ok(state.audit.every((entry) => entry.status === "completed"));
    assert.deepStrictEqual(state.audit.map((entry) => entry.action), ["player.freeze", "player.release", "moderation.warn", "player.kick"]);
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

test("rejects administrative teleports across coordinate spaces", async () => {
    const state = setup();
    state.verifiedTarget.location = () => ({ areaId: "Overland", regionId: "Hogsmeade", destinationId: null, x: 0, y: 0, z: 0, yaw: 0, revision: 2 });
    await assert.rejects(state.service.actions.goto(state.verifiedAdmin, state.verifiedTarget), /same game area/);
    assert.strictEqual(state.service.status().pendingTeleports, 0);
});

test("routes corrective mutations through foundations services with completed audit", async () => {
    const state = setup();
    await state.service.actions.inventory(state.verifiedAdmin, state.verifiedTarget, "give", "test:wand", 2, "test item");
    await state.service.actions.group(state.verifiedAdmin, state.verifiedTarget, "set", "character", "prefect", 1, "promotion");
    await state.service.actions.job(state.verifiedAdmin, state.verifiedTarget, "hire", "auror", 2, "test employment");
    await state.service.actions.banking(state.verifiedAdmin, state.verifiedTarget, "credit", 50, "galleons", "test funds");
    await state.service.actions.reconcile(state.verifiedAdmin, "tx:test", "fail", "closed-test recovery");
    assert.strictEqual(state.inventoryMutations.length, 1);
    assert.strictEqual(state.groupMutations.length, 1);
    assert.strictEqual(state.jobMutations.length, 1);
    assert.strictEqual(state.bankMutations.length, 2);
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
