import assert = require("node:assert");
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import configModule = require("../server/config");
import spawnModule = require("../server/spawn");
import type { HmpCoreCharacter, HmpCoreSession } from "../../hmp-core/types";
import type { HmpLibServer } from "../../hmp-lib/types";
import type { Core, Player, SpawnConfig, TimerHandle } from "../server/internal";

const { createSpawnFlow, normalizeLocation, LAST_LOCATION_KEY } = spawnModule;

interface TestPlayer extends Player { teleported?: HogwartsMpVector3; teleportOptions?: HogwartsMpTeleportOptions }
interface TestTimer extends TimerHandle { callback: () => void; milliseconds: number; cleared: boolean; unrefed: boolean }
interface RecordedEvent { name: string; payload: unknown }
interface ClientEvent { name: string; payload: Record<string, unknown> }

function teleportCompletion(requestId: number, status: number, destination: (HogwartsMpVector3 & { yaw: number }) | null): HogwartsMpTeleportCompletion {
    return {
        requestId,
        status,
        requested: { x: 366784, y: -461527, z: -82610, yaw: null, snapToGround: false, groundSnapDistance: 2000 },
        destination,
        groundSnapped: false,
    };
}

function setup(overrides: Partial<SpawnConfig> = {}) {
    const clientEvents: ClientEvent[] = [];
    const emitted: RecordedEvent[] = [];
    const metadata = new Map<string, unknown>();
    const timers: TestTimer[] = [];
    let nextRequest = 40;
    const player: TestPlayer = {
        id: 7,
        nickname: "Poppy",
        position: { x: 400000, y: -450000, z: -82000 },
        emit(name: string, payload?: unknown) { clientEvents.push({ name, payload: JSON.parse(typeof payload === "string" ? payload : "{}") as Record<string, unknown> }); },
        teleport(x: number, y: number, z: number, options?: HogwartsMpTeleportOptions) { this.teleported = { x, y, z }; this.teleportOptions = options; return nextRequest++; },
    };
    const character: HmpCoreCharacter = { id: 3, accountId: 2, slot: 1, name: "Poppy Sweeting", status: "active", createdAt: "now", updatedAt: "now", deletedAt: null };
    const session: HmpCoreSession<TestPlayer> = {
        player,
        playerId: player.id,
        account: { id: 2, displayName: "Poppy", createdAt: "now", lastSeenAt: "now" },
        principal: { provider: "test", subject: "poppy", trust: "verified" },
        character,
        connectedAt: "now",
    };
    const core = {
        sessions: { get: (candidate: TestPlayer | number) => Number(typeof candidate === "number" ? candidate : candidate?.id) === player.id ? session : null },
        characters: { active: () => character },
        metadata: {
            getCharacter: async (id: number, key: string) => metadata.get(`${id}:${key}`),
            setCharacter: async (id: number, key: string, value: unknown) => { metadata.set(`${id}:${key}`, value); return value; },
        },
    } as unknown as Core;
    const config: SpawnConfig = {
        showSelector: true,
        allowLastLocation: true,
        saveLastLocation: true,
        defaultLocation: "hogwarts",
        teleportTimeoutMs: 10000,
        autoSaveMs: 0,
        locations: [{ key: "hogwarts", label: "Hogwarts", description: "Castle grounds", x: 366784, y: -461527, z: -82610 }],
        ...overrides,
    };
    const flow = createSpawnFlow({
        core,
        config,
        logger: { warn: () => true, error: () => true },
        events: { emit: (name: string, payload: unknown) => emitted.push({ name, payload }) },
        setTimer: (callback: () => void, milliseconds: number) => {
            const timer: TestTimer = { callback, milliseconds, cleared: false, unrefed: false, unref() { timer.unrefed = true; } };
            timers.push(timer);
            return timer;
        },
        clearTimer: (timer: TimerHandle) => { (timer as TestTimer).cleared = true; },
    });
    return { flow, core, config, player, character, session, metadata, timers, clientEvents, emitted };
}

function overlandLocation(player: TestPlayer): HogwartsMpPlayerLocation {
    return { areaId: "Overland", regionId: "Hogwarts", destinationId: null, ...player.position, yaw: 90, revision: 1 };
}

// The reported row: saved in the Entrance Hall, rejoining in the castle grounds region of the same area.
const ENTRANCE_HALL = { areaId: "Overland", regionId: "HOG_EntranceHall", x: 367084, y: -461527, z: -82610, yaw: 90 };
const SCOPED_HOGWARTS = [{ key: "hogwarts", label: "Hogwarts", areaId: "Overland", x: 366784, y: -461527, z: -82610 }];

async function joinWithCharacter(context: ReturnType<typeof setup>): Promise<boolean | number> {
    await context.flow.onLoadingFinished(context.player);
    return context.flow.onCharacterSelected({ session: context.session, character: context.character });
}

test("default and example Hogwarts destinations are available in the actual Overland world", async () => {
    const defaults = configModule.loadConfig({
        config: { load: (_path: string, options: { defaults: SpawnConfig }) => options.defaults },
    } as unknown as HmpLibServer<Player>, { env: {} });
    const example = JSON.parse(readFileSync(resolve(__dirname, "../../../examples/config/data/hmp-spawn.json"), "utf8")) as SpawnConfig;
    for (const config of [defaults, example]) {
        const { flow, player } = setup(config);
        player.location = () => overlandLocation(player);
        assert.deepStrictEqual((await flow.ui.open(player)).locations.map((location) => location.key), ["hogwarts"]);
        assert.strictEqual(await flow.select(player, "hogwarts"), 40);
        player.location = () => ({ ...overlandLocation(player), areaId: "Gringotts" });
        assert.deepStrictEqual((await flow.ui.open(player)).locations, []);
    }
});

test("refreshes an empty selector when the first location report arrives without saving the staging position", async () => {
    const { flow, player, clientEvents, metadata } = setup({
        locations: [{ key: "hogwarts", label: "Hogwarts", areaId: "Overland", x: 366784, y: -461527, z: -82610 }],
    });
    player.location = () => null;
    const initial = await flow.ui.open(player);
    assert.deepStrictEqual(initial.locations, []);
    assert.match(initial.emptyMessage || "", /Waiting/);

    const current = overlandLocation(player);
    player.location = () => current;
    assert.strictEqual(await flow.locationChanged(player, current, null), false);
    const refreshed = clientEvents.at(-1)!;
    assert.strictEqual(refreshed.name, "hmp-spawn:open");
    assert.deepStrictEqual((refreshed.payload.locations as Array<{ key: string }>).map((location) => location.key), ["hogwarts"]);
    assert.strictEqual(refreshed.payload.emptyMessage, undefined);
    assert.strictEqual(metadata.size, 0);
});

test("explains an area mismatch and continues rejecting unsafe destinations", async () => {
    const { flow, player } = setup({
        locations: [{ key: "hogwarts", label: "Hogwarts", areaId: "Overland", x: 366784, y: -461527, z: -82610 }],
    });
    player.location = () => ({ ...overlandLocation(player), areaId: "Gringotts" });
    const model = await flow.ui.open(player);
    assert.deepStrictEqual(model.locations, []);
    assert.match(model.emptyMessage || "", /No destinations are configured/);
    await assert.rejects(flow.select(player, "hogwarts"), /different game area/);
    assert.strictEqual(player.teleported, undefined);
});

test("a slow selector refresh cannot reopen the screen after spawning or disconnecting", async () => {
    for (const action of ["spawn", "disconnect"]) {
        const { flow, core, player, clientEvents } = setup();
        player.location = () => overlandLocation(player);
        await flow.ui.open(player);
        let releaseMetadata!: () => void;
        core.metadata.getCharacter = () => new Promise((resolve) => { releaseMetadata = () => resolve(undefined); });
        const refresh = flow.ui.open(player);
        if (action === "spawn") await flow.select(player, "hogwarts");
        else flow.disconnect(player);
        const before = clientEvents.length;
        releaseMetadata();
        await refresh;
        await flow.locationChanged(player, overlandLocation(player), null);
        assert.strictEqual(clientEvents.length, before);
    }
});

test("validates locations and protects configured defaults", () => {
    assert.throws(() => normalizeLocation({ key: "bad key", x: 0, y: 0, z: 0 }), /Spawn key/);
    assert.throws(() => normalizeLocation({ key: "void", x: Infinity, y: 0, z: 0 }), /coordinate/);
    const { flow } = setup();
    assert.deepStrictEqual(flow.locations.list(), [{ key: "hogwarts", label: "Hogwarts", description: "Castle grounds", kind: "configured" }]);
    assert.strictEqual(flow.locations.unregister("hogwarts"), false);
    const remove = flow.locations.register({ key: "ministry", label: "Ministry", x: 1, y: 2, z: 3, resource: "hmp-ministry" });
    assert.strictEqual(flow.status().locations, 2);
    assert.strictEqual(remove(), true);
});

test("waits for client readiness before opening character spawn selection", async () => {
    const { flow, session, character, player, clientEvents } = setup();
    assert.strictEqual(await flow.onCharacterSelected({ session, character }), false);
    assert.strictEqual(clientEvents.length, 0);
    assert.strictEqual(await flow.onLoadingFinished(player), true);
    const opened = clientEvents.find((event) => event.name === "hmp-spawn:open");
    const openedCharacter = opened?.payload.character as { name?: string } | undefined;
    const openedLocations = opened?.payload.locations as Array<{ key: string }> | undefined;
    assert.strictEqual(openedCharacter?.name, "Poppy Sweeting");
    assert.deepStrictEqual(openedLocations?.map((location) => location.key), ["hogwarts"]);
});

test("offers only the active character's valid last location", async () => {
    const { flow, player, character, metadata } = setup();
    metadata.set(`${character.id}:${LAST_LOCATION_KEY}`, { x: 123, y: 456, z: 789 });
    const model = await flow.ui.open(player);
    assert.deepStrictEqual(model.locations.map((location) => location.key), ["last", "hogwarts"]);
    assert.strictEqual(model.locations[0].kind, "last");
    metadata.set(`${character.id}:${LAST_LOCATION_KEY}`, { x: Number.NaN, y: 0, z: 0 });
    assert.deepStrictEqual((await flow.ui.open(player)).locations.map((location) => location.key), ["hogwarts"]);
});

test("scopes saved locations to the live game area and records context changes", async () => {
    const { flow, player, character, metadata } = setup();
    player.location = () => ({ areaId: "Hogwarts", regionId: "LibraryAnnex", destinationId: null, x: player.position.x, y: player.position.y, z: player.position.z, yaw: 45, revision: 1 });
    metadata.set(`${character.id}:${LAST_LOCATION_KEY}`, { areaId: "Overland", regionId: "Hogsmeade", x: 123, y: 456, z: 789 });
    assert.deepStrictEqual((await flow.ui.open(player)).locations.map((location) => location.key), ["hogwarts"]);
    const requestId = await flow.spawn(player, "hogwarts");
    await flow.complete(player, requestId, 0, teleportCompletion(requestId, 0, { x: 366784, y: -461527, z: -82610, yaw: 45 }));
    const previous = { areaId: "Hogwarts", regionId: "LibraryAnnex", destinationId: null, x: 10, y: 20, z: 30, yaw: 90, revision: 1 };
    assert.strictEqual(await flow.locationChanged(player, null, previous), true);
    assert.deepStrictEqual(metadata.get(`${character.id}:${LAST_LOCATION_KEY}`), { x: 10, y: 20, z: 30, yaw: 90, areaId: "Hogwarts", regionId: "LibraryAnnex", destinationId: null });
});

test("offers and resolves a saved location from another region of the same area", async () => {
    const { flow, player, character, metadata } = setup({ locations: SCOPED_HOGWARTS });
    player.location = () => overlandLocation(player);
    metadata.set(`${character.id}:${LAST_LOCATION_KEY}`, ENTRANCE_HALL);
    const model = await flow.ui.open(player);
    assert.deepStrictEqual(model.locations.map((location) => [location.key, location.kind]), [["last", "last"], ["hogwarts", "configured"]]);
    assert.strictEqual(await flow.select(player, "last"), 40);
    assert.deepStrictEqual(player.teleported, { x: 367084, y: -461527, z: -82610 });
});

test("configured destinations that name a region stay scoped to it", async () => {
    const { flow, player } = setup({ locations: SCOPED_HOGWARTS });
    flow.locations.register({ key: "hall", label: "Entrance Hall", areaId: "Overland", regionId: "HOG_EntranceHall", x: 1, y: 2, z: 3, resource: "hmp-castle" });
    player.location = () => overlandLocation(player);
    assert.deepStrictEqual((await flow.ui.open(player)).locations.map((location) => location.key), ["hogwarts"]);
    await assert.rejects(flow.select(player, "hall"), /different game area/);
    player.location = () => ({ ...overlandLocation(player), regionId: "HOG_EntranceHall" });
    assert.deepStrictEqual((await flow.ui.open(player)).locations.map((location) => location.key), ["hogwarts", "hall"]);
});

test("automatic spawn uses a saved location from another region of the same area", async () => {
    const context = setup({ showSelector: false, locations: SCOPED_HOGWARTS });
    const { player, character, metadata, emitted } = context;
    player.location = () => overlandLocation(player);
    metadata.set(`${character.id}:${LAST_LOCATION_KEY}`, ENTRANCE_HALL);
    assert.strictEqual(await joinWithCharacter(context), 40);
    assert.deepStrictEqual(player.teleported, { x: 367084, y: -461527, z: -82610 });
    const started = emitted.find((event) => event.name === "hmp:spawn:started")?.payload as { location: { key: string } };
    assert.strictEqual(started.location.key, "last");
});

test("automatic spawn falls back to the default when the saved location is in another area", async () => {
    const context = setup({ showSelector: false, locations: SCOPED_HOGWARTS });
    const { player, character, metadata } = context;
    player.location = () => overlandLocation(player);
    metadata.set(`${character.id}:${LAST_LOCATION_KEY}`, { ...ENTRANCE_HALL, areaId: "Gringotts", regionId: "Gringotts" });
    assert.strictEqual(await joinWithCharacter(context), 40);
    assert.deepStrictEqual(player.teleported, { x: 366784, y: -461527, z: -82610 });
});

test("automatic spawn opens the selector when neither the saved location nor the default fits", async () => {
    for (const current of ["unknown", "Gringotts"]) {
        const context = setup({ showSelector: false, locations: SCOPED_HOGWARTS });
        const { flow, player, character, metadata, clientEvents } = context;
        player.location = () => current === "unknown" ? null : { ...overlandLocation(player), areaId: current };
        metadata.set(`${character.id}:${LAST_LOCATION_KEY}`, ENTRANCE_HALL);
        assert.strictEqual(await joinWithCharacter(context), true);
        assert.strictEqual(player.teleported, undefined);
        const opened = clientEvents.at(-1)!;
        assert.strictEqual(opened.name, "hmp-spawn:open");
        assert.deepStrictEqual(opened.payload.locations, []);
        assert.match(String(opened.payload.emptyMessage), current === "unknown" ? /Waiting/ : /No destinations are configured/);
        if (current !== "unknown") continue;
        // The waiting selector fills in once the client reports its area.
        const arrived = overlandLocation(player);
        player.location = () => arrived;
        await flow.locationChanged(player, arrived, null);
        assert.deepStrictEqual((clientEvents.at(-1)!.payload.locations as Array<{ key: string }>).map((location) => location.key), ["last", "hogwarts"]);
    }
});

test("automatic spawn opens the selector when its teleport is refused", async () => {
    const context = setup({ showSelector: false });
    const { player, clientEvents } = context;
    player.teleport = () => { throw new Error("Player is not in the world"); };
    assert.strictEqual(await joinWithCharacter(context), true);
    assert.deepStrictEqual(clientEvents.map((event) => event.name), ["hmp-spawn:transition", "hmp-spawn:failed", "hmp-spawn:open"]);
});

test("a teleport that never completes times out on a referenced timer and reopens selection", async () => {
    const { flow, player, timers, clientEvents, emitted } = setup();
    await flow.spawn(player, "hogwarts");
    assert.strictEqual(timers.length, 1);
    assert.strictEqual(timers[0].milliseconds, 10000);
    // An unref'd timer never fires in a resource's own event loop.
    assert.strictEqual(timers[0].unrefed, false);
    timers[0].callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(flow.status().pending, 0);
    assert.ok(clientEvents.some((event) => event.name === "hmp-spawn:failed" && event.payload.status === 6));
    assert.ok(emitted.some((event) => event.name === "hmp:spawn:failed" && (event.payload as { status: number }).status === 6));
    assert.strictEqual(clientEvents.at(-1)?.name, "hmp-spawn:open");
});

test("uses streamed teleport completion before releasing the player", async () => {
    const { flow, player, character, metadata, timers, clientEvents, emitted } = setup();
    const requestId = await flow.select(player, "hogwarts");
    assert.strictEqual(requestId, 40);
    assert.deepStrictEqual(player.teleported, { x: 366784, y: -461527, z: -82610 });
    assert.strictEqual(flow.status().pending, 1);
    assert.ok(clientEvents.some((event) => event.name === "hmp-spawn:transition"));
    assert.ok(emitted.some((event) => event.name === "hmp:spawn:started"));

    const completion = teleportCompletion(requestId, 0, { x: 366785, y: -461526, z: -82600, yaw: 87 });
    assert.strictEqual(await flow.complete(player, requestId, 0, completion), true);
    assert.strictEqual(flow.status().pending, 0);
    assert.strictEqual(flow.status().spawned, 1);
    assert.strictEqual(timers[0].cleared, true);
    assert.deepStrictEqual(player.teleportOptions, { snapToGround: false, groundSnapDistance: 2000 });
    assert.deepStrictEqual(metadata.get(`${character.id}:${LAST_LOCATION_KEY}`), { x: 366785, y: -461526, z: -82600, yaw: 87 });
    assert.ok(clientEvents.some((event) => event.name === "hmp-spawn:complete"));
    assert.ok(emitted.some((event) => event.name === "hmp:spawn:complete"));
});

test("saves live position only after this character successfully spawned", async () => {
    const { flow, player, character, metadata } = setup();
    assert.strictEqual(await flow.save(player, character), false);
    const requestId = await flow.spawn(player, "hogwarts");
    await flow.complete(player, requestId, 0, teleportCompletion(requestId, 0, { x: 366784, y: -461527, z: -82610, yaw: 0 }));
    player.position = { x: 111, y: 222, z: 333 };
    assert.strictEqual(await flow.save(player, character), true);
    assert.deepStrictEqual(metadata.get(`${character.id}:${LAST_LOCATION_KEY}`), { x: 111, y: 222, z: 333 });
});

test("failed teleports clear pending state and reopen selection", async () => {
    const { flow, player, clientEvents, emitted } = setup();
    const requestId = await flow.spawn(player, "hogwarts");
    assert.strictEqual(await flow.complete(player, requestId, 2, teleportCompletion(requestId, 2, null)), false);
    assert.strictEqual(flow.status().pending, 0);
    assert.ok(clientEvents.some((event) => event.name === "hmp-spawn:failed"));
    assert.strictEqual(clientEvents.at(-1)?.name, "hmp-spawn:open");
    assert.ok(emitted.some((event) => event.name === "hmp:spawn:failed"));
});

test("rejects a success without a matching observed landing transform", async () => {
    const { flow, player, clientEvents } = setup();
    const requestId = await flow.spawn(player, "hogwarts");
    assert.strictEqual(await flow.complete(player, requestId, 0, teleportCompletion(requestId + 1, 0, null)), false);
    assert.strictEqual(flow.status().spawned, 0);
    assert.ok(clientEvents.some((event) => event.name === "hmp-spawn:failed" && event.payload.status === 7));
});

test("removes dynamic locations when their owning resource stops", () => {
    const { flow } = setup();
    flow.locations.register({ key: "hospital", label: "Hospital", x: 10, y: 20, z: 30, resource: "hmp-medical" });
    flow.locations.register({ key: "jail", label: "Jail", x: 40, y: 50, z: 60, resource: "hmp-custody" });
    assert.strictEqual(flow.removeForResource("hmp-medical"), 1);
    assert.deepStrictEqual(flow.locations.list().map((location) => location.key), ["hogwarts", "jail"]);
});
// Source-level TypeScript tests.
