import assert = require("node:assert");
import { test } from "node:test";
import coreModule = require("../server/core");
import repositoryModule = require("../server/repository");
import schemaModule = require("../server/schema");
import type { HmpCoreAccount, HmpCoreCharacter, HmpCoreGroup, HmpCorePrincipal } from "../types";
import type { HmpMySQLMigration } from "../../hmp-mysql/types";
import type { CoreConfig, Database, Player, Repository, Scope } from "../server/internal";

const { createCore } = coreModule;
const { createRepository } = repositoryModule;
const { migrations } = schemaModule;

interface TestPlayer extends Player { mafiahubId?: string }
interface IdentityLink { accountId: number; trust: string }
interface OwnedGroup extends HmpCoreGroup { ownerId: number }
interface RecordedEvent { name: string; payload: unknown }

function hasCode(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

function player(id: number, nickname: string, ids: Partial<TestPlayer> = {}): TestPlayer {
    return { id, nickname, position: { x: 0, y: 0, z: 0 }, emit() {}, teleport: () => 0, ...ids };
}

function memoryRepository() {
    let nextAccount = 1;
    let nextCharacter = 1;
    const accounts = new Map<number, HmpCoreAccount>();
    const identities = new Map<string, IdentityLink>();
    const characters = new Map<number, HmpCoreCharacter>();
    const groups: Record<Scope, Map<string, OwnedGroup>> = { account: new Map(), character: new Map() };
    const metadata: Record<Scope, Map<string, unknown>> = { account: new Map(), character: new Map() };
    const ownerKey = (ownerId: number, key: string) => `${ownerId}:${key}`;

    const repository: Repository = {
        async findIdentity(provider: string, subject: string) {
            const link = identities.get(`${provider}:${subject}`);
            const account = link ? accounts.get(link.accountId) : undefined;
            return link && account ? { account, principal: { provider, subject, trust: link.trust } } : null;
        },
        async findOrCreateAccount(principal: HmpCorePrincipal, displayName: string) {
            const found = await this.findIdentity(principal.provider, principal.subject);
            if (found) return found.account;
            const now = new Date().toISOString();
            const account = { id: nextAccount++, displayName, createdAt: now, lastSeenAt: now };
            accounts.set(account.id, account);
            identities.set(`${principal.provider}:${principal.subject}`, { accountId: account.id, trust: principal.trust });
            return account;
        },
        async linkIdentity(accountId: number, principal: HmpCorePrincipal) {
            const key = `${principal.provider}:${principal.subject}`;
            const found = identities.get(key);
            if (found && found.accountId !== accountId) {
                const error = Object.assign(new Error("identity conflict"), { code: "HMP_CORE_IDENTITY_CONFLICT" });
                throw error;
            }
            identities.set(key, { accountId, trust: principal.trust });
            return true;
        },
        async findAccountById(id: number) { return accounts.get(id) || null; },
        async touchAccount(id: number, displayName: string) {
            const account = accounts.get(id);
            if (account) account.displayName = displayName;
            return account ? 1 : 0;
        },
        async listCharacters(accountId: number) { return [...characters.values()].filter((item) => item.accountId === accountId && item.status === "active").sort((a, b) => a.slot - b.slot); },
        async findCharacterById(id: number) { return characters.get(id) || null; },
        async createCharacter(accountId: number, input: { name: string; slot: number }) {
            const now = new Date().toISOString();
            const character = { id: nextCharacter++, accountId, slot: input.slot, name: input.name, status: "active", createdAt: now, updatedAt: now, deletedAt: null };
            characters.set(character.id, character);
            return character;
        },
        async deleteCharacter(id: number) {
            const character = characters.get(id);
            if (!character || character.status !== "active") return false;
            character.status = "deleted";
            character.deletedAt = new Date().toISOString();
            return true;
        },
        async listAccountGroups(id: number) { return [...groups.account.values()].filter((group) => group.ownerId === id).map(({ ownerId: _, ...group }) => group); },
        async listCharacterGroups(id: number) { return [...groups.character.values()].filter((group) => group.ownerId === id).map(({ ownerId: _, ...group }) => group); },
        async setGroup(scope: Scope, ownerId: number, key: string, grade: number, details: Record<string, unknown>) {
            const group = { scope, key, grade, metadata: details, ownerId };
            groups[scope].set(ownerKey(ownerId, key), group);
            const { ownerId: _, ...result } = group;
            return result;
        },
        async removeGroup(scope: Scope, ownerId: number, key: string) { return groups[scope].delete(ownerKey(ownerId, key)); },
        async getMetadata(scope: Scope, ownerId: number, key: string) { return metadata[scope].get(ownerKey(ownerId, key)); },
        async setMetadata<T>(scope: Scope, ownerId: number, key: string, value: T) { metadata[scope].set(ownerKey(ownerId, key), value); return value; },
        async deleteMetadata(scope: Scope, ownerId: number, key: string) { return metadata[scope].delete(ownerKey(ownerId, key)); },
    };
    return repository;
}

function setup(overrides: Partial<CoreConfig> = {}) {
    const emitted: RecordedEvent[] = [];
    const migrated: Array<{ resource: string; list: HmpMySQLMigration[] }> = [];
    const repository = memoryRepository();
    const database = {
        ready: async () => true,
        migrate: async (resource: string, list: HmpMySQLMigration[]) => { migrated.push({ resource, list }); },
    } as unknown as Database;
    const core = createCore({
        repository,
        database,
        migrations,
        events: { emit: (name: string, payload: unknown) => emitted.push({ name, payload }) },
        listPlayers: () => [],
        logger: { error: () => true },
        config: {
            maxCharacters: 2,
            autoSelectSingleCharacter: false,
            duplicateSession: "reject-new",
            duplicateSessionGroup: "admin",
            duplicateSessionMinimumGrade: 1,
            kickDuplicateSession: false,
            identityOrder: ["steamId", "discordId", "hardwareId"],
            ...overrides,
        },
    });
    return { core, repository, emitted, migrated };
}

test("starts with the resource-owned schema and creates an asserted account session", async () => {
    const { core, emitted, migrated } = setup();
    await core.start();
    assert.strictEqual(core.status().state, "ready");
    assert.strictEqual(migrated[0].resource, "hmp-core");
    assert.strictEqual(migrated[0].list, migrations);

    const connectedPlayer = player(7, "Poppy", { steamId: "76561198000000001" });
    const session = await core.connect(connectedPlayer);
    assert.ok(session);
    assert.strictEqual(session.account.id, 1);
    assert.deepStrictEqual(session.principal, { provider: "client-steam", subject: connectedPlayer.steamId, trust: "asserted" });
    assert.strictEqual(core.accounts.getByPlayer(connectedPlayer), session.account);
    assert.strictEqual(core.sessions.isReady(7), true);
    assert.strictEqual(core.characters.limit(), 2);
    assert.ok(emitted.some((event) => event.name === "hmp:session:ready"));
});

test("manages character slots, scoped groups and JSON metadata", async () => {
    const { core, emitted } = setup();
    await core.start();
    const connectedPlayer = player(7, "Poppy", { discordId: "123456789" });
    const session = await core.connect(connectedPlayer);
    assert.ok(session);
    const first = await core.characters.create(connectedPlayer, { name: "  Poppy   Sweeting " });
    const second = await core.characters.create(connectedPlayer, { name: "Natsai Onai", slot: 2 });
    assert.deepStrictEqual([first.slot, first.name, second.slot], [1, "Poppy Sweeting", 2]);
    await assert.rejects(() => core.characters.create(connectedPlayer, { name: "Third Character" }), (error) => hasCode(error, "HMP_CORE_CHARACTER_LIMIT"));

    await core.characters.select(connectedPlayer, first.id);
    assert.strictEqual(core.characters.active(connectedPlayer)?.id, first.id);
    await core.groups.setAccount(session.account.id, "staff", 1, { title: "helper" });
    await core.groups.setCharacter(first.id, "staff", 3, { title: "admin" });
    assert.strictEqual((await core.groups.effective(connectedPlayer))[0].grade, 3);
    assert.strictEqual(await core.groups.has(connectedPlayer, "STAFF", 2), true);

    await core.metadata.setCharacter(first.id, "appearance", { robe: "blue" });
    assert.deepStrictEqual(await core.metadata.getCharacter(first.id, "appearance"), { robe: "blue" });
    await assert.rejects(() => core.metadata.setAccount(session.account.id, "bad", undefined), (error) => hasCode(error, "HMP_CORE_INVALID_METADATA"));

    assert.strictEqual(await core.characters.delete(connectedPlayer, first.id), true);
    assert.strictEqual(core.characters.active(connectedPlayer), null);
    assert.deepStrictEqual((await core.characters.list(connectedPlayer)).map((item) => item.id), [second.id]);
    assert.ok(emitted.some((event) => event.name === "hmp:character:unloaded"));
});

test("prefers verified providers and rejects duplicate sessions and identity theft", async () => {
    const { core } = setup();
    core.identity.register({
        name: "mafiahub-auth",
        resource: "hmp-auth",
        priority: 100,
        trust: "verified",
        resolve: async (candidate) => {
            const mafiahubId = (candidate as TestPlayer).mafiahubId;
            return mafiahubId ? { provider: "mafiahub", subject: mafiahubId, trust: "verified" } : null;
        },
    });
    await core.start();
    const first = player(1, "One", { steamId: "100", mafiahubId: "mh-1" });
    const duplicate = player(2, "Two", { steamId: "200", mafiahubId: "mh-1" });
    const other = player(3, "Three", { steamId: "300", mafiahubId: "mh-3" });
    const firstSession = await core.connect(first);
    assert.ok(firstSession);
    assert.strictEqual(firstSession.principal.trust, "verified");
    await assert.rejects(() => core.connect(duplicate), (error) => hasCode(error, "HMP_CORE_DUPLICATE_SESSION"));
    const otherSession = await core.connect(other);
    assert.ok(otherSession);

    await core.accounts.linkIdentity(firstSession.account.id, { provider: "mafiahub-alias", subject: "shared", trust: "verified" });
    await assert.rejects(
        () => core.accounts.linkIdentity(otherSession.account.id, { provider: "mafiahub-alias", subject: "shared", trust: "verified" }),
        (error) => hasCode(error, "HMP_CORE_IDENTITY_CONFLICT"),
    );
    assert.strictEqual(await core.disconnect(first), true);
    assert.strictEqual(core.sessions.isReady(first), false);
});

test("allows duplicate sessions for an account group and keeps characters exclusive", async () => {
    const { core } = setup({ duplicateSession: "allow-group" });
    await core.start();
    const first = player(1, "First", { steamId: "100" });
    const second = player(2, "Second", { steamId: "100" });
    const firstSession = await core.connect(first);
    assert.ok(firstSession);
    await assert.rejects(() => core.connect(second), (error) => hasCode(error, "HMP_CORE_DUPLICATE_SESSION"));

    await core.groups.setAccount(firstSession.account.id, "admin", 1);
    const secondSession = await core.connect(second);
    assert.ok(secondSession);
    assert.strictEqual(core.sessions.all().length, 2);

    const professor = await core.characters.create(first, { name: "Professor Fig" });
    const student = await core.characters.create(first, { name: "Natsai Onai" });
    await core.characters.select(first, professor.id);
    await assert.rejects(() => core.characters.select(second, professor.id), (error) => hasCode(error, "HMP_CORE_CHARACTER_IN_USE"));
    await assert.rejects(() => core.characters.delete(second, professor.id), (error) => hasCode(error, "HMP_CORE_CHARACTER_IN_USE"));
    await core.characters.select(second, student.id);

    assert.strictEqual(core.characters.active(first)?.id, professor.id);
    assert.strictEqual(core.characters.active(second)?.id, student.id);
    assert.strictEqual(await core.disconnect(first), true);
    await core.characters.select(second, professor.id);
    assert.strictEqual(core.characters.active(second)?.id, professor.id);
});

test("repository refuses to transfer an existing identity", async () => {
    const calls: unknown[][] = [];
    const database = {
        query: async () => [],
        single: async () => ({
            id: 4,
            display_name: "Existing",
            created_at: "now",
            last_seen_at: "now",
            provider: "mafiahub",
            subject: "subject",
            trust_level: "verified",
        }),
        update: async (...args: unknown[]) => { calls.push(args); return 1; },
        insert: async (...args: unknown[]) => { calls.push(args); return 1; },
    } as unknown as Database;
    const repository = createRepository(database);
    await assert.rejects(
        () => repository.linkIdentity(5, { provider: "mafiahub", subject: "subject", trust: "verified" }),
        (error) => hasCode(error, "HMP_CORE_IDENTITY_CONFLICT"),
    );
    assert.strictEqual(calls.length, 0);
});
// Source-level TypeScript tests.
