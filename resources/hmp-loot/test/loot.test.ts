import assert = require("node:assert");
import configModule = require("../server/config");
import serviceModule = require("../server/service");
import type { HmpLootDefinition, HmpLootFamilies, HmpLootItem, HmpLootRecord, HmpLootTake } from "../types";
import type { LootConfig, LootRepository } from "../server/internal";

const { loadConfig } = configModule;
const { createLootService } = serviceModule;

interface FakePlayer { id: number; nickname: string; characterId: number | null }
type View = { items?: HmpLootItem[]; locked?: boolean } | null;

const EGGS = [{ itemId: "AshwinderEggs", count: 3 }];

function definition(key: string, scope: "character" | "shared", respawnSeconds: number | null, kind: HmpLootDefinition["kind"] = "chest"): HmpLootDefinition {
    return { key, kind, position: { x: 1, y: 2, z: 3 }, yaw: 90, items: EGGS, scope, respawnSeconds };
}

function fakeRepository(seed: HmpLootRecord[] = []) {
    const rows = new Map(seed.map((row) => [`${row.key}/${row.characterId ?? 0}`, row]));
    const calls: string[] = [];
    const repository: LootRepository = {
        async start() { calls.push("start"); },
        async loadAll() { return [...rows.values()]; },
        async put(record) { calls.push(`put ${record.key}/${record.characterId ?? 0}`); rows.set(`${record.key}/${record.characterId ?? 0}`, record); },
        async remove(key, characterId) { calls.push(`remove ${key}/${characterId ?? 0}`); rows.delete(`${key}/${characterId ?? 0}`); },
    };
    return { repository, rows, calls };
}

function fakeNative() {
    let nextId = 10;
    const placed = new Map<number, { kind: string; items: HmpLootItem[]; mode: string; model?: string }>();
    const views = new Map<string, View>();
    const calls: string[] = [];
    const suppressedCalls: Array<Partial<HmpLootFamilies>> = [];
    const lootables = {
        place(kind: string, _x: number, _y: number, _z: number, _yaw: number, options: { items: HmpLootItem[]; mode: "shared" | "perPlayer"; model?: string }) {
            if (kind === "barrel") throw new TypeError("kind must be chest, moonstone or foragable");
            const id = nextId++;
            placed.set(id, { kind, items: options.items, mode: options.mode, model: options.model });
            return id;
        },
        setItems(id: number, items: HmpLootItem[]) { calls.push(`setItems ${id} ${items.length}`); placed.get(id)!.items = items; return true; },
        setView(id: number, player: FakePlayer, view: View) { calls.push(`setView ${id} #${player.id} ${JSON.stringify(view)}`); views.set(`${id}/${player.id}`, view); return true; },
        remove(id: number) { calls.push(`remove ${id}`); return placed.delete(id); },
    };
    const world = {
        lootSuppressed: { chests: false, moonstones: false, foragables: false },
        suppressLoot(families: Partial<HmpLootFamilies>) { suppressedCalls.push(families); return true; },
    };
    return { lootables, world, placed, views, calls, suppressedCalls };
}

function makeConfig(lootables: HmpLootDefinition[], suppressGameLoot: HmpLootFamilies = { chests: true, moonstones: true, foragables: false }): LootConfig {
    return { command: "loot", enableCommands: true, adminGroups: [], suppressGameLoot, lootables, sweepMs: 1000 };
}

async function run(): Promise<void> {
    // Config: defaults, a full entry, and the validation errors a server owner will hit.
    const defaults = { lootables: [] };
    const Hmp = (loaded: Record<string, unknown>) => ({ config: { load: (_path: string, options: { defaults: Record<string, unknown> }) => ({ ...options.defaults, ...loaded }), env: { boolean: (_v: unknown, fallback: boolean) => fallback } } });
    const config = loadConfig(Hmp(defaults) as never, { env: {} as NodeJS.ProcessEnv });
    assert.strictEqual(config.command, "loot");
    assert.deepStrictEqual(config.suppressGameLoot, { chests: false, moonstones: false, foragables: false });
    assert.strictEqual(loadConfig(Hmp(defaults) as never, { env: { HMP_LOOT_COMMAND: "LOOTS" } as NodeJS.ProcessEnv }).command, "loots");
    const full = loadConfig(Hmp({
        suppressGameLoot: { chests: true },
        lootables: [{ key: "courtyard.chest", position: { x: 1, y: 2, z: 3 }, items: [{ itemId: "AshwinderEggs" }], respawnSeconds: 60 }],
    }) as never, { env: {} as NodeJS.ProcessEnv });
    assert.deepStrictEqual(full.suppressGameLoot, { chests: true, moonstones: false, foragables: false });
    assert.deepStrictEqual(full.lootables[0], { key: "courtyard.chest", kind: "chest", position: { x: 1, y: 2, z: 3 }, yaw: 0, items: [{ itemId: "AshwinderEggs", count: 1 }], scope: "character", respawnSeconds: 60 });
    const bad = (lootables: unknown[], pattern: RegExp) => assert.throws(() => loadConfig(Hmp({ lootables }) as never, { env: {} as NodeJS.ProcessEnv }), pattern);
    bad([{ key: "a", kind: "barrel", position: { x: 0, y: 0, z: 0 } }], /kind must be/);
    bad([{ key: "a b", position: { x: 0, y: 0, z: 0 } }], /key must be/);
    bad([{ key: "a", position: { x: 0, y: 0 } }], /position.z must be a number/);
    bad([{ key: "a", scope: "guild", position: { x: 0, y: 0, z: 0 } }], /scope must be/);
    bad([{ key: "a", respawnSeconds: 0, position: { x: 0, y: 0, z: 0 } }], /respawnSeconds must be a positive integer/);
    bad([{ key: "a", items: [{ itemId: "X", count: 0 }], position: { x: 0, y: 0, z: 0 } }], /count must be a positive integer/);
    bad([{ key: "a", position: { x: 0, y: 0, z: 0 } }, { key: "a", position: { x: 0, y: 0, z: 0 } }], /used twice/);
    assert.throws(() => loadConfig(Hmp({ suppressGameLoot: { chests: "yes" } }) as never, { env: {} as NodeJS.ProcessEnv }), /suppressGameLoot.chests must be a boolean/);

    // Startup: expired takes are deleted, a live shared take places the lootable empty, the game's loot
    // goes off, and players without a character are locked out of character-scoped loot.
    let clock = 1_000_000;
    let sweep: () => void = () => {};
    const { repository, rows, calls } = fakeRepository([
        { key: "shared-chest", characterId: null, accountId: 1, takenAt: clock - 10_000, respawnAt: clock + 50_000 },
        { key: "eggs", characterId: 7, accountId: 1, takenAt: clock - 90_000, respawnAt: clock - 1 },
        { key: "eggs", characterId: 8, accountId: 2, takenAt: clock - 5_000, respawnAt: clock + 55_000 },
        { key: "gone", characterId: 7, accountId: 1, takenAt: clock, respawnAt: null },
    ]);
    const native = fakeNative();
    const alice: FakePlayer = { id: 1, nickname: "Alice", characterId: 7 };
    const bob: FakePlayer = { id: 2, nickname: "Bob", characterId: 8 };
    const guest: FakePlayer = { id: 3, nickname: "Guest", characterId: null };
    const online = [alice, bob, guest];
    const core = {
        characters: { active: (player: FakePlayer) => (player.characterId === null ? null : { id: player.characterId }) },
        accounts: { getByPlayer: (player: FakePlayer) => ({ id: 100 + player.id }) },
    };
    const service = createLootService<FakePlayer>({
        config: makeConfig([definition("eggs", "character", 60, "foragable"), definition("shared-chest", "shared", 60), definition("forever", "character", null, "moonstone"), definition("broken", "shared", null, "barrel" as never)]),
        lootables: native.lootables,
        world: native.world,
        repository,
        migrations: [],
        core: core as never,
        players: () => online,
        now: () => clock,
        schedule: (fn) => { sweep = fn; return () => { sweep = () => {}; }; },
    });
    assert.strictEqual(service.status().state, "starting");
    await service.ready();
    assert.strictEqual(service.status().state, "ready");
    assert.deepStrictEqual(native.suppressedCalls, [{ chests: true, moonstones: true, foragables: false }]);
    assert.ok(calls.includes("remove eggs/7"), "an expired take is deleted at startup");
    assert.ok(rows.has("gone/7"), "a take of a lootable no longer configured is kept");
    const ids = Object.fromEntries(service.lootables.list().map((entry) => [entry.key, entry.lootableId]));
    assert.strictEqual(ids.broken, 0, "a lootable the builtin refused is listed as not placed");
    assert.deepStrictEqual(native.placed.get(ids.eggs), { kind: "foragable", items: EGGS, mode: "perPlayer", model: undefined });
    assert.deepStrictEqual(native.placed.get(ids["shared-chest"])?.items, [], "a live shared take places it empty");
    assert.strictEqual(native.placed.get(ids["shared-chest"])?.mode, "shared");
    assert.strictEqual(service.lootables.get("shared-chest")?.taken, true);
    assert.deepStrictEqual(native.views.get(`${ids.eggs}/1`), null, "alice's take expired, so she sees the eggs");
    assert.deepStrictEqual(native.views.get(`${ids.eggs}/2`), { items: [] }, "bob's live take keeps his view empty");
    assert.deepStrictEqual(native.views.get(`${ids.eggs}/3`), { locked: true }, "no character, nothing offered");
    assert.strictEqual(native.views.has(`${ids["shared-chest"]}/1`), false, "shared loot needs no views");

    // A take is recorded against the character and published; another character of the same player
    // starts from the lootable's contents, and the first one gets its empty view back.
    const takes: HmpLootTake<FakePlayer>[] = [];
    service.lootables.onTaken((take) => takes.push(take));
    await service.taken(alice, ids.eggs, EGGS);
    assert.deepStrictEqual(takes.map((take) => [take.key, take.characterId, take.accountId, take.respawnAt]), [["eggs", 7, 101, clock + 60_000]]);
    assert.ok(calls.includes("put eggs/7"));
    assert.deepStrictEqual(service.lootables.record("eggs", 7)?.respawnAt, clock + 60_000);
    alice.characterId = 9;
    service.sync(alice);
    assert.deepStrictEqual(native.views.get(`${ids.eggs}/1`), null);
    alice.characterId = 7;
    service.sync(alice);
    assert.deepStrictEqual(native.views.get(`${ids.eggs}/1`), { items: [] });
    await service.taken(guest, ids.eggs, EGGS);
    assert.strictEqual(takes.length, 1, "a take without a character is not recorded");
    await service.taken(alice, 999, EGGS);
    assert.strictEqual(takes.length, 1, "a lootable this resource did not place is ignored");
    await service.taken(alice, ids.forever, EGGS);
    assert.strictEqual(service.lootables.record("forever", 7)?.respawnAt, null, "a lootable without respawnSeconds is taken for good");

    // Respawns: a take stays in effect until the sweep releases it; then the shared chest refills,
    // alice's and bob's eggs come back to them, and the forever take stays.
    clock += 61_000;
    assert.ok(service.lootables.record("eggs", 7), "an expired take is in effect until the sweep");
    assert.deepStrictEqual(native.views.get(`${ids.eggs}/1`), { items: [] });
    sweep();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(native.calls.includes(`setItems ${ids["shared-chest"]} 1`), "the shared chest is refilled");
    assert.deepStrictEqual(native.views.get(`${ids.eggs}/1`), null, "alice's eggs are back");
    assert.deepStrictEqual(native.views.get(`${ids.eggs}/2`), null, "bob's eggs are back");
    assert.ok(calls.includes("remove shared-chest/0") && calls.includes("remove eggs/8"));
    assert.strictEqual(service.lootables.get("shared-chest")?.taken, false);
    assert.strictEqual(service.lootables.record("eggs", 7), null);
    assert.ok(service.lootables.record("forever", 7));

    // Reset ends takes now; an unknown key throws.
    assert.strictEqual(await service.lootables.reset("forever", 7), 1);
    assert.deepStrictEqual(native.views.get(`${ids.forever}/1`), null);
    await service.taken(bob, ids["shared-chest"], EGGS);
    assert.strictEqual(service.lootables.get("shared-chest")?.taken, true);
    assert.strictEqual(await service.lootables.reset("shared-chest"), 1);
    assert.strictEqual(service.lootables.get("shared-chest")?.taken, false);
    await assert.rejects(service.lootables.reset("nope"), /unknown lootable/);

    // Stop removes what it placed and lifts only the families it switched off.
    service.stop();
    assert.strictEqual(native.placed.size, 0);
    assert.deepStrictEqual(native.suppressedCalls.at(-1), { chests: false, moonstones: false });
    assert.strictEqual(service.status().state, "stopped");

    // A refused suppression degrades startup instead of placing half the loot.
    const refused = fakeNative();
    refused.world.suppressLoot = () => false;
    const degraded = createLootService<FakePlayer>({
        config: makeConfig([definition("eggs", "character", 60)]),
        lootables: refused.lootables, world: refused.world, repository: fakeRepository().repository, migrations: [], core: core as never, players: () => [],
    });
    await assert.rejects(degraded.ready(), /refused/);
    assert.strictEqual(degraded.status().state, "degraded");
    assert.strictEqual(refused.placed.size, 0);
    console.log("hmp-loot unit tests passed");
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
