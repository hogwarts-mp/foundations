import assert = require("node:assert");
import configModule = require("../server/config");
import menuModule = require("../server/menu");
import repositoryModule = require("../server/repository");
import serviceModule = require("../server/service");
import type { HmpStoredBeast } from "../types";
import type { BeastsRepository, NativeBeasts, NativeCapturedBeast } from "../server/internal";

const { loadConfig } = configModule;
const { parseBeasts } = repositoryModule;
const { createBeastService } = serviceModule;
const { createBeastMenu, speciesLabel, colorLabel } = menuModule;

interface FakePlayer { id: number; nickname: string; characterId: number | null; position?: { x: number; y: number; z: number; yaw: number } | null }

const CATALOG = [
    { id: "Hippogriff", colors: [{ id: "Default" }, { id: "Variation1" }] },
    { id: "Niffler", colors: [{ id: "Default" }] },
];

// The host's per-connection bag, and every world beast it spawned.
function fakeNative() {
    let nextEntry = 1;
    let nextBeast = 100;
    const bags = new Map<number, Map<number, NativeCapturedBeast>>();
    const spawned: Array<{ id: number; species: string; opts: Record<string, unknown>; capturable: boolean }> = [];
    const bagOf = (player: FakePlayer) => {
        if (!bags.has(player.id)) bags.set(player.id, new Map());
        return bags.get(player.id)!;
    };
    const native: NativeBeasts<FakePlayer> = {
        bagOf: (player) => [...bagOf(player).values()].map((entry) => ({ ...entry })),
        giveCaptured: (player, beast) => {
            if (!CATALOG.some((entry) => entry.id === beast.species)) throw new TypeError("unknown species");
            const entry = { id: nextEntry++, species: beast.species, color: beast.color || "Default", gender: beast.gender || "male", name: beast.name || "" };
            bagOf(player).set(entry.id, entry);
            return { ...entry };
        },
        takeCaptured: (player, id) => bagOf(player).delete(id),
        create: (species, opts) => {
            const record = { id: nextBeast++, species, opts: { ...opts }, capturable: false };
            spawned.push(record);
            return record;
        },
        catalog: () => CATALOG,
    };
    // A real catch: the game adds the entry, then the host raises beastCaptured.
    const catchInto = (player: FakePlayer, species: string, color = "Default"): NativeCapturedBeast => {
        const entry = { id: nextEntry++, species, color, gender: "female" as const, name: "" };
        bagOf(player).set(entry.id, entry);
        return { ...entry };
    };
    // A Field Guide release: the game drops the entry, then the host raises beastReleased.
    const releaseFrom = (player: FakePlayer, id: number): NativeCapturedBeast => {
        const entry = bagOf(player).get(id)!;
        bagOf(player).delete(id);
        return { ...entry };
    };
    return { native, bags, spawned, bagOf, catchInto, releaseFrom };
}

function fakeRepository(seed: Record<number, HmpStoredBeast[]> = {}) {
    const rows = new Map<number, string>(Object.entries(seed).map(([id, beasts]) => [Number(id), JSON.stringify(beasts)]));
    const calls: string[] = [];
    let gate: Promise<void> | null = null;
    const repository: BeastsRepository = {
        async start() { calls.push("start"); },
        async load(characterId) {
            if (gate) await gate;
            return rows.has(characterId) ? parseBeasts(rows.get(characterId)) : null;
        },
        async save(characterId, beasts) { calls.push(`save ${characterId}`); rows.set(characterId, JSON.stringify(beasts)); },
    };
    const stored = (characterId: number): HmpStoredBeast[] => parseBeasts(rows.get(characterId) ?? "");
    return { repository, rows, calls, stored, hold(promise: Promise<void> | null) { gate = promise; } };
}

function setup(options: { seed?: Record<number, HmpStoredBeast[]>; players?: FakePlayer[]; respawn?: boolean; capturable?: boolean; native?: boolean } = {}) {
    const native = fakeNative();
    const repo = fakeRepository(options.seed);
    const players = options.players ?? [];
    const emitted: Array<{ eventName: string; payload: any }> = [];
    const warnings: string[] = [];
    let uids = 0;
    const service = createBeastService<FakePlayer>({
        config: { command: "beasts", enableCommands: true, release: { respawn: options.respawn ?? true, capturable: options.capturable ?? false } },
        native: options.native === false ? null : native.native,
        repository: repo.repository,
        migrations: [],
        core: { characters: { active: (player: FakePlayer | number) => {
            const found = typeof player === "number" ? players.find((entry) => entry.id === player) : player;
            return found?.characterId ? { id: found.characterId } : null;
        } } as never },
        players: () => players,
        positionOf: (player) => player.position ?? null,
        emit: (eventName, payload) => emitted.push({ eventName, payload }),
        logger: { warn: (message: string) => { warnings.push(message); return true; }, info: () => true },
        now: () => 1_000,
        uid: () => `uid-${++uids}`,
    });
    return { service, native, repo, players, emitted, warnings };
}

const beast = (uid: string, species: string, color = "Default"): HmpStoredBeast => ({ uid, species, color, gender: "male", name: "", caughtAt: 1 });

async function run(): Promise<void> {
    // Config: defaults, overrides and the type errors a server owner will hit.
    const Hmp = (loaded: Record<string, unknown>) => ({ config: { load: (_path: string, options: { defaults: Record<string, unknown> }) => ({ ...options.defaults, ...loaded }) } });
    assert.deepStrictEqual(loadConfig(Hmp({}) as never, { env: {} as NodeJS.ProcessEnv }), { command: "beasts", enableCommands: true, release: { respawn: true, capturable: false } });
    assert.strictEqual(loadConfig(Hmp({ command: "Pets" }) as never, { env: {} as NodeJS.ProcessEnv }).command, "pets");
    assert.throws(() => loadConfig(Hmp({ command: "/beasts" }) as never, { env: {} as NodeJS.ProcessEnv }), /command must be/);
    assert.deepStrictEqual(loadConfig(Hmp({ release: { respawn: false } }) as never, { env: {} as NodeJS.ProcessEnv }).release, { respawn: false, capturable: false });
    assert.throws(() => loadConfig(Hmp({ release: { capturable: "yes" } }) as never, { env: {} as NodeJS.ProcessEnv }), /must be a boolean/);

    // A stored row survives hand edits: what doesn't parse is dropped.
    assert.deepStrictEqual(parseBeasts("not json"), []);
    assert.deepStrictEqual(parseBeasts(JSON.stringify([{ uid: "a", species: "Niffler" }, { species: "NoUid" }, 7])), [{ uid: "a", species: "Niffler", color: "", gender: "male", name: "", caughtAt: 0 }]);

    // Ready: a player already playing gets their stored bag; a beast stored without a colour keeps the one the game rolls.
    {
        const alice: FakePlayer = { id: 1, nickname: "Alice", characterId: 10 };
        const { service, native, repo, emitted } = setup({ players: [alice], seed: { 10: [beast("old", "Hippogriff", "")] } });
        await service.ready();
        assert.strictEqual(service.status().state, "ready");
        assert.strictEqual(service.status().loadedBags, 1);
        assert.deepStrictEqual(native.native.bagOf(alice).map((entry) => entry.species), ["Hippogriff"]);
        assert.strictEqual(repo.stored(10)[0].color, "Default");

        // A catch is kept at once, under the character.
        const caught = native.catchInto(alice, "Niffler");
        await service.captured(alice, caught);
        assert.deepStrictEqual(repo.stored(10).map((entry) => entry.species), ["Hippogriff", "Niffler"]);
        assert.strictEqual(emitted.at(-1)!.eventName, "hmp:beasts:captured");
        assert.strictEqual(emitted.at(-1)!.payload.characterId, 10);

        // A release drops it from the bag and brings it back where the player stood, not catchable yet.
        await service.released(alice, native.releaseFrom(alice, caught.id), { x: 1, y: 2, z: 3 });
        assert.deepStrictEqual(repo.stored(10).map((entry) => entry.species), ["Hippogriff"]);
        assert.strictEqual(native.spawned.length, 1);
        assert.deepStrictEqual(native.spawned[0], { id: 100, species: "Niffler", opts: { x: 1, y: 2, z: 3, gender: "female", color: "Default", preferredOwnerId: 1 }, capturable: false });
        const releasedEvent = emitted.at(-1)!;
        assert.strictEqual(releasedEvent.eventName, "hmp:beasts:released");
        assert.strictEqual(releasedEvent.payload.respawnedBeastId, 100);
        assert.strictEqual(releasedEvent.payload.beast.species, "Niffler");

        // A character switch: the old character's beasts leave the game, the new one's arrive.
        service.detach(alice);
        assert.deepStrictEqual(native.native.bagOf(alice), []);
        alice.characterId = 11;
        await service.attach(alice, 11);
        assert.deepStrictEqual(native.native.bagOf(alice), []);

        // The API reaches the game while the character is loaded, and only the database while it isn't.
        const given = await service.bag.give(alice, { species: "Hippogriff", color: "Variation1", gender: "female", name: "Buckbeak" }, { resource: "test" });
        assert.deepStrictEqual(native.native.bagOf(alice).map((entry) => `${entry.species}/${entry.color}/${entry.name}`), ["Hippogriff/Variation1/Buckbeak"]);
        assert.deepStrictEqual((await service.bag.list(alice)).map((entry) => entry.uid), [given.uid]);
        await service.bag.give(10, { species: "Niffler", gender: "male" });
        assert.deepStrictEqual(repo.stored(10).map((entry) => entry.species), ["Hippogriff", "Niffler"]);
        assert.strictEqual(repo.stored(10)[1].color, "", "an offline give leaves the colour for the game to roll");
        assert.strictEqual(native.native.bagOf(alice).length, 1, "an offline character's beast reached a loaded game");

        assert.strictEqual(await service.bag.take(alice, given.uid), true);
        assert.deepStrictEqual(native.native.bagOf(alice), []);
        assert.deepStrictEqual(repo.stored(11), []);
        assert.strictEqual(await service.bag.take(alice, "missing"), false);

        // Bad input is refused before anything is stored.
        await assert.rejects(service.bag.give(alice, { species: "Dragon" }), /Unknown beast species/);
        await assert.rejects(service.bag.give(alice, { species: "Niffler", color: "Gold" }), /no colour 'Gold'/);
        await assert.rejects(service.bag.give(alice, { species: "Niffler", name: "x".repeat(65) }), /over 64 bytes/);
        await assert.rejects(service.bag.list({ id: 9, nickname: "Nobody", characterId: null }), /no character loaded/);

        service.stop();
        await assert.rejects(service.bag.list(alice), /stopped/);
    }

    // A release with respawn off is simply gone; with capturable on, the beast can be caught again.
    {
        const bob: FakePlayer = { id: 2, nickname: "Bob", characterId: 20 };
        const off = setup({ players: [bob], respawn: false, seed: { 20: [beast("b1", "Niffler")] } });
        await off.service.ready();
        const entry = off.native.native.bagOf(bob)[0];
        await off.service.released(bob, off.native.releaseFrom(bob, entry.id), { x: 0, y: 0, z: 0 });
        assert.strictEqual(off.native.spawned.length, 0);
        assert.deepStrictEqual(off.repo.stored(20), []);

        const on = setup({ players: [bob], capturable: true, seed: { 20: [beast("b2", "Niffler")] } });
        await on.service.ready();
        const again = on.native.native.bagOf(bob)[0];
        await on.service.released(bob, on.native.releaseFrom(bob, again.id), { x: 0, y: 0, z: 0 });
        assert.strictEqual(on.native.spawned[0].capturable, true);
    }

    // A load still in flight when the player leaves the character gives up, so the bag never lands on the next one.
    {
        const cara: FakePlayer = { id: 3, nickname: "Cara", characterId: 30 };
        const { service, native, repo } = setup({ players: [], seed: { 30: [beast("c1", "Hippogriff")] } });
        await service.ready();
        // Left before the load began...
        const early = service.attach(cara, 30);
        service.detach(cara);
        await early;
        assert.deepStrictEqual(native.native.bagOf(cara), []);
        // ...and while it was reading the database.
        let release!: () => void;
        repo.hold(new Promise<void>((resolve) => { release = resolve; }));
        const loading = service.attach(cara, 30);
        await new Promise((resolve) => setImmediate(resolve));
        service.detach(cara);
        release();
        await loading;
        assert.deepStrictEqual(native.native.bagOf(cara), []);
        assert.strictEqual(service.status().loadedBags, 0);
    }

    // A resource restart mid-session: what the game already holds gives way to what is stored, so nothing doubles.
    {
        const dan: FakePlayer = { id: 4, nickname: "Dan", characterId: 40 };
        const { service, native } = setup({ players: [dan], seed: { 40: [beast("d1", "Hippogriff")] } });
        native.native.giveCaptured(dan, { species: "Hippogriff" });
        await service.ready();
        assert.strictEqual(native.native.bagOf(dan).length, 1);
    }

    // Started mid-session with nothing stored yet: what the game already holds is kept, not wiped.
    {
        const gil: FakePlayer = { id: 7, nickname: "Gil", characterId: 70 };
        const hank: FakePlayer = { id: 8, nickname: "Hank", characterId: 80 };
        const { service, native, repo } = setup({ players: [gil] });
        native.native.giveCaptured(gil, { species: "Niffler", color: "Default", gender: "male" });
        await service.ready();
        assert.strictEqual(native.native.bagOf(gil).length, 1);
        assert.deepStrictEqual(repo.stored(70).map((entry) => entry.species), ["Niffler"]);
        const entry = native.native.bagOf(gil)[0];
        await service.released(gil, native.releaseFrom(gil, entry.id), { x: 0, y: 0, z: 0 });
        assert.deepStrictEqual(repo.stored(70), [], "the adopted entry was not mapped");
        // A character load is not a mid-session start: the stored (here empty) bag wins.
        native.native.giveCaptured(hank, { species: "Niffler" });
        await service.attach(hank, 80);
        assert.deepStrictEqual(native.native.bagOf(hank), []);
    }

    // bag.release lets a beast go in front of the player, facing them, as the Field Guide would.
    {
        const ivy: FakePlayer = { id: 9, nickname: "Ivy", characterId: 90, position: { x: 1000, y: 2000, z: 300, yaw: 90 } };
        const { service, native, repo, emitted } = setup({ players: [ivy], seed: { 90: [beast("i1", "Hippogriff", "Variation1"), beast("i2", "Niffler")] } });
        await service.ready();
        const result = await service.bag.release(ivy, "i1", { resource: "test" });
        assert.ok(result);
        assert.strictEqual(result.beast.species, "Hippogriff");
        assert.strictEqual(result.respawnedBeastId, 100);
        assert.deepStrictEqual(native.native.bagOf(ivy).map((entry) => entry.species), ["Niffler"]);
        assert.deepStrictEqual(repo.stored(90).map((entry) => entry.uid), ["i2"]);
        const spawn = native.spawned[0].opts as { x: number; y: number; z: number; yaw: number; color: string };
        assert.ok(Math.abs(spawn.x - 1000) < 1e-6 && Math.abs(spawn.y - 2300) < 1e-6 && spawn.z === 300, "not 3 m in front");
        assert.strictEqual(spawn.yaw, 270);
        assert.strictEqual(spawn.color, "Variation1");
        assert.strictEqual(emitted.at(-1)!.payload.source, "api");
        assert.strictEqual(await service.bag.release(ivy, "i1"), null);

        // Without a position or a loaded character there is nowhere to let it go.
        ivy.position = null;
        await assert.rejects(service.bag.release(ivy, "i2"), /position is not known/);
        await assert.rejects(service.bag.release({ id: 99, nickname: "Ghost", characterId: 1 }, "i2"), /no character loaded/);
        assert.deepStrictEqual(repo.stored(90).map((entry) => entry.uid), ["i2"]);

        // A Field Guide release says where it came from.
        const entry = native.native.bagOf(ivy)[0];
        await service.released(ivy, native.releaseFrom(ivy, entry.id), { x: 0, y: 0, z: 0 });
        assert.strictEqual(emitted.at(-1)!.payload.source, "fieldGuide");
    }

    // bag.rename swaps the game's entry for one carrying the new name; offline, it changes only the row.
    {
        const jo: FakePlayer = { id: 10, nickname: "Jo", characterId: 100 };
        const { service, native, repo } = setup({ players: [jo], seed: { 100: [beast("j1", "Hippogriff", "Variation1")], 101: [beast("k1", "Niffler")] } });
        await service.ready();
        const renamed = await service.bag.rename(jo, "j1", "  Buckbeak  ");
        assert.strictEqual(renamed!.name, "Buckbeak");
        assert.deepStrictEqual(native.native.bagOf(jo).map((entry) => `${entry.species}/${entry.color}/${entry.name}`), ["Hippogriff/Variation1/Buckbeak"]);
        assert.strictEqual(repo.stored(100)[0].name, "Buckbeak");
        // The swapped entry is still mapped: taking it empties the game's bag.
        assert.strictEqual(await service.bag.take(jo, "j1"), true);
        assert.deepStrictEqual(native.native.bagOf(jo), []);

        assert.strictEqual((await service.bag.rename(101, "k1", "Goldie"))!.name, "Goldie");
        assert.strictEqual((await service.bag.rename(101, "k1", ""))!.name, "");
        assert.strictEqual(repo.stored(101)[0].name, "");
        assert.strictEqual(await service.bag.rename(101, "missing", "x"), null);
        await assert.rejects(service.bag.rename(101, "k1", "x".repeat(65)), /over 64 bytes/);
    }

    // Menu labels read as words, not game ids.
    assert.strictEqual(speciesLabel("HippogriffOffspring"), "Young Hippogriff");
    assert.strictEqual(speciesLabel("GiantPurpleToad"), "Giant Purple Toad");
    assert.strictEqual(colorLabel("UniqueVariation2"), "Rare variant 2");
    assert.strictEqual(colorLabel("Default"), "Standard coat");

    // The menu: list, pick, free with a confirmation, rename, page through a big bag.
    {
        const kim: FakePlayer = { id: 11, nickname: "Kim", characterId: 110, position: { x: 0, y: 0, z: 0, yaw: 0 } };
        const { service, native, repo } = setup({ players: [kim], seed: { 110: [beast("m2", "Niffler"), beast("m1", "Hippogriff")] } });
        await service.ready();
        const shown: any[] = [];
        const notes: any[] = [];
        let answers: Array<string | null | Record<string, string>> = [];
        const ui = {
            context: async (_player: FakePlayer, menu: any) => { shown.push(menu); return answers.shift() as string | null ?? null; },
            alert: async (_player: FakePlayer, dialog: any) => { shown.push(dialog); return answers.shift() as "confirm" | "cancel" | null; },
            input: async (_player: FakePlayer, dialog: any) => { shown.push(dialog); return answers.shift() as Record<string, string> | null; },
            notify: (_player: FakePlayer, note: any) => { notes.push(note); return true; },
        };
        const menu = createBeastMenu<FakePlayer>({ bag: service.bag, ui: ui as never, config: { command: "beasts", enableCommands: true, release: { respawn: true, capturable: false } } });

        // Free the hippogriff: list, its actions, the confirmation, then the shorter list, then close.
        answers = ["beast:m1", "free", "confirm", null];
        await menu.open(kim);
        assert.deepStrictEqual(shown[0].options.map((option: any) => option.title), ["Hippogriff", "Niffler"]);
        assert.strictEqual(shown[2].title, "Free Hippogriff?");
        assert.deepStrictEqual(shown[3].options.map((option: any) => option.title), ["Niffler"]);
        assert.deepStrictEqual(repo.stored(110).map((entry) => entry.uid), ["m2"]);
        assert.strictEqual(native.spawned.length, 1);
        assert.strictEqual(notes.at(-1).tone, "success");

        // Keeping it at the confirmation changes nothing; closing the actions closes the menu.
        shown.length = 0;
        answers = ["beast:m2", "free", "cancel", "beast:m2", null];
        await menu.open(kim);
        assert.strictEqual(repo.stored(110).length, 1);
        assert.strictEqual(shown.length, 5);

        // Rename, then Back to the list, which now shows the name.
        shown.length = 0;
        answers = ["beast:m2", "rename", { name: "Goldie" }, null];
        await menu.open(kim);
        assert.strictEqual(shown[3].options[0].title, "Goldie");
        assert.strictEqual(native.native.bagOf(kim)[0].name, "Goldie");

        // A second open while one is up does nothing.
        shown.length = 0;
        let release!: (value: string | null) => void;
        ui.context = async (_player, menuShown) => { shown.push(menuShown); return new Promise((resolve) => { release = resolve; }); };
        const first = menu.open(kim);
        await menu.open(kim);
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(shown.length, 1);
        release(null);
        await first;

        // An empty bag still shows a menu, with a placeholder.
        ui.context = async (_player, menuShown) => { shown.push(menuShown); return null; };
        await service.bag.take(kim, "m2");
        shown.length = 0;
        await menu.open(kim);
        assert.strictEqual(shown[0].options[0].disabled, true);

        // 31 beasts: two pages.
        for (let index = 0; index < 31; index++) await service.bag.give(kim, { species: "Niffler", color: "Default", gender: "male" });
        shown.length = 0;
        answers = ["page:next", null];
        ui.context = async (_player, menuShown) => { shown.push(menuShown); return answers.shift() as string | null ?? null; };
        await menu.open(kim);
        assert.strictEqual(shown[0].options.length, 31);
        assert.strictEqual(shown[0].options.at(-1).id, "page:next");
        assert.deepStrictEqual(shown[1].options.map((option: any) => option.id), ["beast:" + (await service.bag.list(kim)).at(-1)!.uid, "page:previous"]);
    }

    // A host without beast capture: the bag API still reads and writes the database; nothing reaches a game.
    {
        const eve: FakePlayer = { id: 5, nickname: "Eve", characterId: 50 };
        const { service, repo } = setup({ players: [eve], native: false });
        await service.ready();
        assert.strictEqual(service.status().state, "degraded");
        await service.bag.give(eve, { species: "Niffler", color: "Default", gender: "male" });
        assert.strictEqual(repo.stored(50).length, 1);
    }

    // A catch with no character loaded is not kept anywhere.
    {
        const finn: FakePlayer = { id: 6, nickname: "Finn", characterId: null };
        const { service, native, repo, warnings } = setup({ players: [finn] });
        await service.ready();
        await service.captured(finn, native.catchInto(finn, "Niffler"));
        assert.strictEqual(repo.calls.filter((call) => call.startsWith("save")).length, 0);
        assert.ok(warnings.some((message) => message.includes("no character loaded")));
    }
}

run().then(() => console.log("hmp-beasts tests passed"));
