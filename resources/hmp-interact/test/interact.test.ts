import assert = require("node:assert");
import { test } from "node:test";
import normalizeModule = require("../shared/normalize");
import configModule = require("../server/config");
import serviceModule = require("../server/service");
import clientModule = require("../client/interact");
import type { HmpInteractPlayer, HmpInteractionDefinition } from "../types";

const { normalizeInteraction } = normalizeModule;
const { loadConfig } = configModule;
const { createInteractService } = serviceModule;
const { createInteractClient } = clientModule;

interface TestPlayer extends HmpInteractPlayer {
    messages: Array<{ event: string; payload: unknown }>;
}

function setup() {
    let clock = 1000;
    const player = (id: number, x = 0): TestPlayer => ({
        id,
        nickname: `Player ${id}`,
        position: { x, y: 0, z: 0 },
        location() { return { areaId: "Hogwarts", regionId: "LibraryAnnex", destinationId: null, x: this.position.x, y: this.position.y, z: this.position.z, yaw: 0, revision: 1 }; },
        messages: [],
        emit(event, payload) { this.messages.push({ event, payload }); },
    });
    const first = player(7);
    const second = player(8);
    const groups = new Set(["student"]);
    const items = new Map([["wand", 1]]);
    const notifications: unknown[] = [];
    const menus: unknown[] = [];
    const progresses: unknown[] = [];
    let menuChoice: string | null = null;
    let progressResult = true;
    const emitted: Array<{ event: string; args: unknown[] }> = [];
    const created: Array<{ key: string; model: string | number; options: unknown }> = [];
    const destroyed: string[] = [];
    const charactersCreated: Array<{ key: string; characterId: string; options: unknown }> = [];
    const charactersDestroyed: string[] = [];
    let failedCreates = 0;
    const service = createInteractService<TestPlayer>({
        core: {
            characters: { active: () => ({ id: 12, name: "Poppy" }) },
            groups: { has: async (_candidate: TestPlayer | number, key: string) => groups.has(key) },
        } as never,
        inventory: {
            inventory: { has: async (_candidate: TestPlayer | number, name: string, amount = 1) => (items.get(name) || 0) >= amount },
        } as never,
        ui: {
            notify(_candidate: TestPlayer, value: unknown) { notifications.push(value); return true; },
            async context(_candidate: TestPlayer, value: unknown) { menus.push(value); return menuChoice; },
            async progress(_candidate: TestPlayer, value: unknown) { progresses.push(value); return progressResult; },
        } as never,
        players: () => [first, second],
        events: { emit(event, ...args) { emitted.push({ event, args }); } },
        worldObjects: {
            create(key, model, options) { if (failedCreates-- > 0) throw new Error("world object unavailable"); created.push({ key, model, options }); return {}; },
            destroy(key) { destroyed.push(key); return true; },
        },
        characters: {
            create(key, characterId, options) { if (characterId === "Peeves") return undefined; charactersCreated.push({ key, characterId, options }); return {}; },
            destroy(key) { charactersDestroyed.push(key); return true; },
        },
        logger: { info() {}, warn() {}, error() {} },
        now: () => clock,
    });
    return {
        service, first, second, groups, items, notifications, menus, progresses, emitted, created, destroyed,
        charactersCreated, charactersDestroyed,
        choose(value: string | null) { menuChoice = value; },
        completeProgress(value: boolean) { progressResult = value; },
        advance(milliseconds: number) { clock += milliseconds; },
        failNextWorldCreate() { failedCreates = 1; },
    };
}

test("normalizes bounded interaction definitions and rejects ambiguous options", () => {
    const normalized = normalizeInteraction({
        id: "shop.counter",
        resource: "hmp-shops",
        label: "  Browse\nWands  ",
        position: { x: 1, y: 2, z: 3 },
        radius: 200,
        promptDistance: 900,
        areaId: "Hogwarts",
        regionId: "LibraryAnnex",
        options: [{ id: "browse", label: "Browse", handler() {} }],
    });
    assert.strictEqual(normalized.label, "Browse Wands");
    assert.strictEqual(normalized.promptDistance, 200);
    assert.strictEqual(normalized.areaId, "Hogwarts");
    assert.throws(() => normalizeInteraction({
        id: "duplicate",
        resource: "test",
        label: "Duplicate",
        position: { x: 0, y: 0, z: 0 },
        options: [
            { id: "same", label: "One", handler() {} },
            { id: "same", label: "Two", handler() {} },
        ],
    }), /duplicated/);
});

test("registers owned zones, publishes optional props and cleans up safely", () => {
    const state = setup();
    const dispose = state.service.register({
        id: "wardrobe",
        resource: "hmp-characters",
        label: "Change appearance",
        position: { x: 10, y: 20, z: 30 },
        object: { model: "/Game/Wardrobe.Wardrobe", yaw: 90 },
        handler() {},
    });
    assert.strictEqual(state.service.status().interactions, 1);
    assert.strictEqual(state.created[0].key, "hmp-interact:wardrobe");
    assert.ok(state.first.messages.some((message) => message.event === "hmp-interact:snapshot"));
    assert.throws(() => state.service.register({
        id: "wardrobe", resource: "other", label: "Hijack", position: { x: 0, y: 0, z: 0 }, handler() {},
    }), /already owned/);
    state.failNextWorldCreate();
    assert.throws(() => state.service.register({
        id: "wardrobe", resource: "hmp-characters", label: "Replacement", position: { x: 0, y: 0, z: 0 },
        object: { model: "/Game/Other.Other" }, handler() {},
    }), /world object unavailable/);
    assert.strictEqual(state.service.get("wardrobe")?.label, "Change appearance");
    assert.strictEqual(dispose(), true);
    assert.strictEqual(dispose(), false);
    assert.deepStrictEqual(state.destroyed, ["hmp-interact:wardrobe", "hmp-interact:wardrobe"]);
});

test("passes a prop's look and reach to the host, never below its radius, and refuses a lifetime or motion", () => {
    const state = setup();
    const look = {
        model: "/Game/Cauldron.Cauldron",
        streamRange: 50,
        drawDistance: 120,
        animation: "/Game/Bubble_anm.Bubble_anm",
        material: " /Game/M_Copper.M_Copper ",
        startFx: "/Game/VFX/NS_Puff.NS_Puff",
    };
    state.service.register({ id: "cauldron.look", resource: "hmp-potions", label: "Brew", position: { x: 0, y: 0, z: 0 }, radius: 300, object: look, handler() {} });
    assert.deepStrictEqual(state.created[0].options, {
        x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0, scale: 1, collision: true,
        streamRange: 300, drawDistance: 300,
        animation: "/Game/Bubble_anm.Bubble_anm", material: "/Game/M_Copper.M_Copper", startFx: "/Game/VFX/NS_Puff.NS_Puff",
    });
    state.service.register({ id: "cauldron.far", resource: "hmp-potions", label: "Brew", position: { x: 0, y: 0, z: 0 }, object: { model: "/Game/Cauldron.Cauldron", streamRange: 90000, drawDistance: 0 }, handler() {} });
    assert.strictEqual((state.created[1].options as { streamRange: number }).streamRange, 90000);
    assert.strictEqual((state.created[1].options as { drawDistance: number }).drawDistance, 0, "0 never culls");
    state.service.register({ id: "cauldron.plain", resource: "hmp-potions", label: "Brew", position: { x: 0, y: 0, z: 0 }, object: { model: "/Game/Cauldron.Cauldron" }, handler() {} });
    const plain = state.created[2].options as Record<string, unknown>;
    assert.deepStrictEqual(["streamRange", "drawDistance", "animation", "material", "startFx"].map((field) => plain[field]), [undefined, undefined, undefined, undefined, undefined], "an unset option keeps the host's own default, as on an older host");
    for (const extra of [{ ttl: 30 }, { motion: { speed: 100 } }, { endFx: "/Game/VFX/NS_Puff.NS_Puff" }, { shrinkOut: 1 }]) {
        assert.throws(() => normalizeInteraction({
            id: "cauldron.timed", resource: "hmp-potions", label: "Brew", position: { x: 0, y: 0, z: 0 },
            object: { model: "/Game/Cauldron.Cauldron", ...extra } as never, handler() {},
        }), /lasts as long as the interaction/);
    }
});

test("publishes an optional character at the zone position and destroys it with the zone", () => {
    const state = setup();
    const dispose = state.service.register({
        id: "shop.ollivander",
        resource: "hmp-shops",
        label: "Browse wands",
        position: { x: 10, y: 20, z: 30 },
        character: { characterId: "GerboldOllivander", yaw: 90, label: "  Gerbold Ollivander " },
        handler() {},
    });
    assert.deepStrictEqual(state.charactersCreated, [{
        key: "hmp-interact:shop.ollivander",
        characterId: "GerboldOllivander",
        options: { x: 10, y: 20, z: 30, yaw: 90, scale: 1, label: "Gerbold Ollivander", promptHeight: 100 },
    }]);
    assert.strictEqual(state.created.length, 0);
    assert.strictEqual(state.service.get("shop.ollivander")?.promptOffsetZ, 40);
    assert.throws(() => state.service.register({
        id: "shop.refused", resource: "hmp-shops", label: "Refused", position: { x: 0, y: 0, z: 0 },
        character: { characterId: "Peeves" }, handler() {},
    }), /was refused/);
    assert.throws(() => normalizeInteraction({
        id: "shop.bad", resource: "hmp-shops", label: "Bad", position: { x: 0, y: 0, z: 0 },
        character: { characterId: "/Game/Not.An_Id" }, handler() {},
    }), /invalid character id/);
    assert.strictEqual(dispose(), true);
    assert.deepStrictEqual(state.charactersDestroyed, ["hmp-interact:shop.ollivander"]);
    assert.deepStrictEqual(state.destroyed, []);
});

test("seats one player at a time and frees the seat when they stand, leave or it goes away", async () => {
    const state = setup();
    const seatMessages = (player: TestPlayer) => player.messages.filter((message) => message.event === "hmp-interact:seat").map((message) => JSON.parse(String(message.payload)));
    let sat = 0;
    state.service.register({
        id: "bench.1",
        resource: "hmp-furniture",
        label: "Sit",
        position: { x: 0, y: 0, z: 0 },
        object: { model: "/Game/Gameplay/Stations/Bench/Props/SM_HM_Bench_A.SM_HM_Bench_A" },
        seat: { position: { x: 0, y: 56, z: -90 }, yaw: 180, clip: "/Game/Sit.Sit", exit: { x: 0, y: 120, z: -90 } },
        handler() { sat++; },
    });
    assert.strictEqual(await state.service.trigger(state.first, "bench.1"), true);
    assert.strictEqual(sat, 1);
    assert.deepStrictEqual(seatMessages(state.first), [{
        id: "bench.1", position: { x: 0, y: 56, z: -90 }, yaw: 180, clip: "/Game/Sit.Sit", exit: { x: 0, y: 120, z: -90 },
    }]);
    assert.strictEqual(await state.service.trigger(state.second, "bench.1"), false);
    assert.deepStrictEqual(state.notifications.at(-1), { description: "Someone is already sitting there.", tone: "warning" });
    assert.strictEqual(sat, 1, "an occupied seat runs no handler");
    assert.strictEqual(state.service.stand(state.second, "bench.1"), false, "only the occupant can free a seat");
    assert.strictEqual(state.service.stand(state.first, "bench.1"), true);
    state.advance(1000);
    assert.strictEqual(await state.service.trigger(state.second, "bench.1"), true);
    state.service.disconnect(state.second);
    state.advance(1000);
    assert.strictEqual(await state.service.trigger(state.first, "bench.1"), true, "a seated player leaving frees the seat");
    state.service.unregister("bench.1", "hmp-furniture");
    state.service.register({ id: "bench.1", resource: "hmp-furniture", label: "Sit", position: { x: 0, y: 0, z: 0 }, seat: { position: { x: 0, y: 0, z: -90 } } });
    state.advance(1000);
    assert.strictEqual(await state.service.trigger(state.second, "bench.1"), true, "a seat with no handler only seats, and unregistering freed it");
    assert.deepStrictEqual(seatMessages(state.second).at(-1), { id: "bench.1", position: { x: 0, y: 0, z: -90 } });
    const base = { id: "bench.bad", resource: "test", label: "Sit", position: { x: 0, y: 0, z: 0 }, radius: 200 };
    assert.throws(() => normalizeInteraction({ ...base, seat: { position: { x: 500, y: 0, z: 0 } } }), /within its radius/);
    assert.throws(() => normalizeInteraction({ ...base, seat: { position: { x: 0, y: 0, z: 0 }, exit: { x: 0, y: 0, z: Number.NaN } } }), /finite seat position/);
    assert.throws(() => normalizeInteraction({ ...base, seat: { position: { x: 0, y: 0, z: 0 } }, options: [{ id: "a", label: "A", handler() {} }] }), /cannot seat/);
});

test("rejects forged distance and requirements, then applies cooldown after execution", async () => {
    const state = setup();
    let uses = 0;
    state.service.register({
        id: "restricted",
        resource: "test",
        label: "Restricted",
        position: { x: 0, y: 0, z: 0 },
        radius: 100,
        requirements: { character: true, groups: [{ key: "student" }], items: [{ name: "wand" }] },
        cooldownMs: 1000,
        handler() { uses++; },
    });
    state.first.position.x = 500;
    assert.strictEqual(await state.service.trigger(state.first, "restricted"), false);
    state.advance(201);
    state.first.position.x = 0;
    state.items.clear();
    assert.strictEqual(await state.service.trigger(state.first, "restricted"), false);
    assert.strictEqual(uses, 0);
    state.items.set("wand", 1);
    state.advance(201);
    assert.strictEqual(await state.service.trigger(state.first, "restricted"), true);
    state.advance(201);
    assert.strictEqual(await state.service.trigger(state.first, "restricted"), false);
    assert.strictEqual(uses, 1);
    state.advance(1001);
    assert.strictEqual(await state.service.trigger(state.first, "restricted"), true);
    assert.strictEqual(uses, 2);
});

test("filters snapshots and triggers by live game area", async () => {
    const state = setup();
    state.service.register({ id: "castle", resource: "test", label: "Castle", areaId: "Hogwarts", position: { x: 0, y: 0, z: 0 }, handler() {} });
    state.service.register({ id: "hamlet", resource: "test", label: "Hamlet", areaId: "Overland", position: { x: 0, y: 0, z: 0 }, handler() {} });
    state.first.messages.length = 0;
    assert.strictEqual(state.service.sync(state.first), true);
    const snapshot = JSON.parse(String(state.first.messages.at(-1)?.payload)) as { interactions: Array<{ id: string }> };
    assert.deepStrictEqual(snapshot.interactions.map((entry) => entry.id), ["castle"]);
    assert.strictEqual(await state.service.trigger(state.first, "hamlet"), false);
    state.first.location = () => null;
    state.first.messages.length = 0;
    state.service.sync(state.first);
    const travelling = JSON.parse(String(state.first.messages.at(-1)?.payload)) as { interactions: unknown[] };
    assert.deepStrictEqual(travelling.interactions, []);
});

test("offers validated options, rechecks progress and enforces exclusive execution", async () => {
    const state = setup();
    let selected = "";
    state.choose("brew");
    state.service.register({
        id: "cauldron",
        resource: "hmp-potions",
        label: "Cauldron",
        position: { x: 0, y: 0, z: 0 },
        options: [
            { id: "locked", label: "Locked", requirements: { items: [{ name: "moonstone" }] }, handler() {} },
            { id: "brew", label: "Brew", progress: { duration: 500, canCancel: true }, handler(context) { selected = context.option?.id || ""; } },
        ],
    });
    assert.strictEqual(await state.service.trigger(state.first, "cauldron"), true);
    assert.strictEqual(selected, "brew");
    assert.strictEqual(state.progresses.length, 1);
    const menu = state.menus[0] as { options: Array<{ id: string; disabled: boolean }> };
    assert.strictEqual(menu.options.find((option) => option.id === "locked")?.disabled, true);

    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    state.service.register({
        id: "exclusive",
        resource: "test",
        label: "Exclusive",
        position: { x: 0, y: 0, z: 0 },
        exclusive: true,
        async handler() { await pending; },
    });
    state.advance(201);
    const firstUse = state.service.trigger(state.first, "exclusive");
    await Promise.resolve();
    assert.strictEqual(await state.service.trigger(state.second, "exclusive"), false);
    release();
    assert.strictEqual(await firstUse, true);
});

test("client arbitrates one prompt, sends only its selected id and tears down", () => {
    const handlers = new Map<string, (payload?: unknown) => unknown>();
    const sent: Array<{ event: string; payload: unknown }> = [];
    const prompts: unknown[][] = [];
    let keyHandler: (() => void) | null = null;
    let position = { x: 0, y: 0, z: 0 };
    let locked = false;
    let clock = 1000;
    let cleared = false;
    let hidden = 0;
    const client = createInteractClient({
        events: { on: (event, handler) => handlers.set(event, handler), emitServer: (event, payload) => sent.push({ event, payload }) },
        input: { shortcuts: {
            register(definition) {
                keyHandler = () => { if (!definition.when || definition.when()) definition.handler("f", "down"); };
                return () => { cleared = true; return true; };
            },
        } },
        hud: { showPrompt: (...args) => prompts.push(args), hidePrompt: () => { hidden++; } },
        localPlayer: { getPosition: () => position },
        game: { areControlsLocked: () => locked },
        timers: { setInterval: () => 99 as unknown as ReturnType<typeof setInterval>, clearInterval() { cleared = true; } },
        now: () => clock,
    });
    assert.strictEqual(sent[0].event, "hmp-interact:ready");
    assert.strictEqual(client.receiveSnapshot({ revision: 1, interactions: [
        { id: "near", label: "Near", position: { x: 20, y: 0, z: 0 }, promptDistance: 100, promptOffsetZ: 50, priority: 0 },
        { id: "priority", label: "Priority", position: { x: 50, y: 0, z: 0 }, promptDistance: 100, promptOffsetZ: 50, priority: 2 },
    ] }), true);
    assert.strictEqual(client.status().active, "priority");
    assert.deepStrictEqual(prompts.at(-1), ["F", "Priority", 50, 0, 50]);
    assert.ok(keyHandler);
    (keyHandler as unknown as () => void)();
    assert.deepStrictEqual(JSON.parse(String(sent.at(-1)?.payload)), { id: "priority", revision: 1 });
    clock += 300;
    locked = true;
    assert.strictEqual(client.scan(), null);
    assert.ok(hidden > 0);
    locked = false;
    position = { x: 1000, y: 0, z: 0 };
    assert.strictEqual(client.scan(), null);
    assert.strictEqual(client.receiveSnapshot({ revision: 0, interactions: [] }), false);
    assert.strictEqual(client.stop(), true);
    assert.strictEqual(client.stop(), false);
    assert.strictEqual(cleared, true);
});

test("the outline command is off unless configured, and outlines reach only the player who asked", () => {
    const Hmp = (file: Record<string, unknown>) => ({
        config: {
            load: <T>(_path: string | string[], options?: { defaults?: Partial<T> }) => ({ ...options?.defaults, ...file }) as T,
            merge: () => ({}) as never,
            env: { boolean: (value: unknown, fallback = false) => value === "true" ? true : value === "false" ? false : fallback, number: () => undefined, json: () => undefined as never },
        },
        text: { clean: (value: unknown, maximum = 120) => String(value ?? "").trim().slice(0, maximum) },
    }) as unknown as Parameters<typeof loadConfig>[0];
    assert.deepStrictEqual(loadConfig(Hmp({}), { env: {} }), { enableCommands: false, command: "interact" });
    assert.deepStrictEqual(loadConfig(Hmp({ enableCommands: true, command: "Zones" }), { env: {} }), { enableCommands: true, command: "zones" });
    assert.strictEqual(loadConfig(Hmp({ enableCommands: true }), { env: { HMP_INTERACT_COMMANDS: "false" } }).enableCommands, false);
    assert.throws(() => loadConfig(Hmp({ command: "zones!" }), { env: {} }), /unsupported characters/);

    const state = setup();
    state.service.register({ id: "counter", resource: "hmp-shops", label: "Shop", position: { x: 0, y: 0, z: 0 }, radius: 300, promptDistance: 120, handler() {} });
    const last = (player: TestPlayer) => JSON.parse(String(player.messages.filter((message) => message.event === "hmp-interact:snapshot").at(-1)?.payload));
    assert.strictEqual(last(state.first).outlines, undefined);
    assert.strictEqual(last(state.first).interactions[0].radius, undefined, "radius stays on the server by default");
    assert.strictEqual(state.service.setOutlines(state.first), true);
    assert.strictEqual(last(state.first).outlines, true);
    assert.deepStrictEqual([last(state.first).interactions[0].radius, last(state.first).interactions[0].promptDistance], [300, 120]);
    state.service.register({ id: "counter.2", resource: "hmp-shops", label: "Shop", position: { x: 0, y: 0, z: 0 }, handler() {} });
    assert.strictEqual(last(state.first).interactions.length, 2);
    assert.ok(last(state.first).interactions.every((zone: { radius?: number }) => zone.radius !== undefined), "a broadcast keeps the outlines on");
    assert.strictEqual(last(state.second).outlines, undefined, "another player's snapshot is unchanged");
    assert.strictEqual(state.service.setOutlines(state.first), false);
    assert.strictEqual(last(state.first).outlines, undefined);
    state.service.setOutlines(state.first, true);
    state.service.disconnect(state.first);
    state.service.sync(state.first);
    assert.strictEqual(last(state.first).outlines, undefined, "a reconnect starts with outlines off");
});

test("client rings each zone while outlines are on and warns once on a host without Shapes", () => {
    const shapeCalls: unknown[][] = [];
    const notices: string[] = [];
    const make = (shapes?: { create(key: string, shape: unknown): boolean; destroy(key: string): boolean; destroyAll(): number }) => createInteractClient({
        events: { on() {}, emitServer() {} },
        input: { shortcuts: { register: () => () => true } },
        hud: { showPrompt() {}, hidePrompt() {} },
        localPlayer: { getPosition: () => ({ x: 5000, y: 0, z: 0 }) },
        game: { areControlsLocked: () => false, notify: (message) => notices.push(message) },
        shapes: shapes as never,
        timers: { setInterval: () => 99 as unknown as ReturnType<typeof setInterval>, clearInterval() {} },
    });
    const client = make({
        create: (key, shape) => { shapeCalls.push(["create", key, shape]); return true; },
        destroy: (key) => { shapeCalls.push(["destroy", key]); return true; },
        destroyAll: () => { shapeCalls.push(["destroyAll"]); return 0; },
    });
    const counter = { id: "counter", label: "Shop", position: { x: 0, y: 0, z: 90 }, promptDistance: 120, promptOffsetZ: 100, priority: 0, radius: 300 };
    const door = { ...counter, id: "door", promptDistance: 250, radius: 250 };
    client.receiveSnapshot({ revision: 1, interactions: [counter, door] });
    assert.deepStrictEqual(shapeCalls, [], "outlines are off until the server says otherwise");
    client.receiveSnapshot({ revision: 1, outlines: true, interactions: [counter, door] });
    assert.deepStrictEqual(shapeCalls.map((call) => call[1]), ["radius:counter", "prompt:counter", "radius:door"], "a prompt ring only where the prompt is nearer than the radius");
    assert.deepStrictEqual(shapeCalls[0][2], { type: "ring", center: { x: 0, y: 0, z: 90 }, radius: 300, thickness: 6, color: { r: 1, g: 0.72, b: 0.18, a: 0.9 } });
    assert.strictEqual(client.status().outlines, true);
    client.receiveSnapshot({ revision: 2, outlines: true, interactions: [counter] });
    assert.deepStrictEqual(shapeCalls.slice(3), [["destroy", "radius:door"]], "an unchanged ring is not redrawn");
    client.receiveSnapshot({ revision: 3, interactions: [counter] });
    assert.deepStrictEqual(shapeCalls.slice(4), [["destroyAll"]]);
    client.stop();

    const older = make();
    older.receiveSnapshot({ revision: 1, outlines: true, interactions: [counter] });
    older.receiveSnapshot({ revision: 2, outlines: true, interactions: [counter] });
    assert.deepStrictEqual(notices, ["[interact] zone outlines need a HogwartsMP host with Shapes"]);
    older.stop();
});

test("client sits on the server's seat, stands up on F and hands back a seat it cannot take", () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const sent: Array<{ event: string; payload: unknown }> = [];
    const prompts: unknown[][] = [];
    const calls: unknown[][] = [];
    let keyHandler: (() => void) | null = null;
    let clock = 1000;
    const localPlayer: {
        getPosition(): { x: number; y: number; z: number };
        anchor?(at: unknown): boolean;
        releaseAnchor?(exit?: unknown): boolean;
        playClip?(clipPath?: string, options?: unknown): boolean;
    } = {
        getPosition: () => ({ x: 0, y: 0, z: 0 }),
        anchor: (at) => { calls.push(["anchor", at]); return true; },
        releaseAnchor: (...exit) => { calls.push(["release", ...exit]); return true; },
        playClip: (...args) => { calls.push(["clip", ...args]); return true; },
    };
    const client = createInteractClient({
        events: { on: (event, handler) => handlers.set(event, handler), emitServer: (event, payload) => sent.push({ event, payload }) },
        input: { shortcuts: { register(definition) { keyHandler = () => { if (!definition.when || definition.when()) definition.handler("f", "down"); }; return () => true; } } },
        hud: { showPrompt: (...args) => prompts.push(args), hidePrompt() {} },
        localPlayer,
        game: { areControlsLocked: () => false },
        timers: { setInterval: () => 99 as unknown as ReturnType<typeof setInterval>, clearInterval() {} },
        now: () => clock,
    });
    const stands = () => sent.filter((message) => message.event === "hmp-interact:stand").map((message) => JSON.parse(String(message.payload)).id);
    const press = () => { clock += 300; (keyHandler as unknown as () => void)(); };
    const bench = { id: "bench", label: "Sit", position: { x: 0, y: 0, z: 0 }, promptDistance: 100, promptOffsetZ: 50, priority: 0 };
    client.receiveSnapshot({ revision: 1, interactions: [bench, { ...bench, id: "other", label: "Other", priority: 5 }] });
    handlers.get("hmp-interact:seat")?.(JSON.stringify({ id: "bench", position: { x: 0, y: 56, z: -90 }, yaw: 180, clip: "/Game/Sit.Sit", exit: { x: 0, y: 120, z: -90 } }));
    assert.deepStrictEqual(calls, [["anchor", { x: 0, y: 56, z: -90, yaw: 180, camera: true }], ["clip", "/Game/Sit.Sit", { loop: false, hold: true }]]);
    assert.strictEqual(client.status().active, "bench", "a seated player's prompt stays on their seat over a higher priority zone");
    assert.deepStrictEqual(prompts.at(-1), ["F", "Stand up", 0, 0, 50]);
    press();
    assert.deepStrictEqual(calls.slice(2), [["release", { x: 0, y: 120, z: -90 }], ["clip", ""]]);
    assert.deepStrictEqual(stands(), ["bench"]);
    assert.ok(!sent.some((message) => message.event === "hmp-interact:trigger"), "standing up triggers nothing");
    handlers.get("anchorReleased")?.("script", { x: 0, y: 56, z: -90 });
    assert.deepStrictEqual(stands(), ["bench"], "the release the stand-up caused is not a second stand");

    handlers.get("hmp-interact:seat")?.({ id: "bench", position: { x: 0, y: 56, z: -90 } });
    handlers.get("anchorReleased")?.("death", { x: 0, y: 56, z: -90 });
    assert.deepStrictEqual(stands(), ["bench", "bench"], "a host release frees the seat");
    handlers.get("hmp-interact:seat")?.({ id: "bench", position: { x: 0, y: 56, z: -90 } });
    client.receiveSnapshot({ revision: 2, interactions: [] });
    assert.deepStrictEqual(calls.at(-1), ["release"], "the seat's interaction going away stands the player up in place");
    assert.deepStrictEqual(stands(), ["bench", "bench", "bench"]);

    delete localPlayer.anchor;
    client.receiveSnapshot({ revision: 3, interactions: [bench] });
    assert.strictEqual(handlers.get("hmp-interact:seat")?.({ id: "bench", position: { x: 0, y: 56, z: -90 } }), false);
    assert.deepStrictEqual(stands(), ["bench", "bench", "bench", "bench"], "a host without anchor hands the seat straight back");
    assert.strictEqual(prompts.at(-1)?.[1], "Sit");
    client.stop();
});
