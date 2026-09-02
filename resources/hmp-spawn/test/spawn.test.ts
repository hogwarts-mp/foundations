import assert = require("node:assert");
import { test } from "node:test";
import spawnModule = require("../server/spawn");
import type { HmpCoreCharacter, HmpCoreSession } from "../../hmp-core/types";
import type { Core, Player, SpawnConfig, TimerHandle } from "../server/internal";

const { createSpawnFlow, normalizeLocation, LAST_LOCATION_KEY } = spawnModule;

interface TestPlayer extends Player { teleported?: HogwartsMpVector3; teleportOptions?: HogwartsMpTeleportOptions }
interface TestTimer extends TimerHandle { callback: () => void; milliseconds: number; cleared: boolean }
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
        setTimer: (callback: () => void, milliseconds: number) => { const timer: TestTimer = { callback, milliseconds, cleared: false }; timers.push(timer); return timer; },
        clearTimer: (timer: TimerHandle) => { (timer as TestTimer).cleared = true; },
    });
    return { flow, core, config, player, character, session, metadata, timers, clientEvents, emitted };
}

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
