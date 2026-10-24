import assert = require("node:assert");
import serverModule = require("../server/service");
import clientModule = require("../client/service");
import type { HmpBlipPlayer } from "../types";

const { createBlipsService } = serverModule;
const { createBlipsClient } = clientModule;

interface TestPlayer extends HmpBlipPlayer {
    area: string;
    region: string;
    messages: Array<{ name: string; payload: unknown }>;
}

function makePlayer(id: number, area = "Hogwarts", region = "GreatHall", virtualWorld = 0): TestPlayer {
    return {
        id,
        nickname: `Player${id}`,
        position: { x: id * 100, y: 20, z: 30 },
        virtualWorld,
        area,
        region,
        messages: [],
        emit(name, raw) {
            let payload = raw;
            if (typeof raw === "string") try { payload = JSON.parse(raw); } catch (_) { /* keep raw */ }
            this.messages.push({ name, payload });
        },
        location() {
            return { areaId: this.area, regionId: this.region, destinationId: null, x: this.position.x, y: this.position.y, z: this.position.z, yaw: 0, revision: 1 };
        },
    };
}

async function run(): Promise<void> {
    const first = makePlayer(1);
    const second = makePlayer(2);
    const third = makePlayer(3, "Hogsmeade", "Square");
    const connected = [first, second, third];
    const memberships = new Map<number, Set<string>>([[1, new Set(["job:auror"])], [2, new Set(["job:auror"])] ]);
    const broadcasts: Array<{ name: string; payload: unknown }> = [];
    const timers: Array<{ handler: () => void; cleared: boolean }> = [];
    const service = createBlipsService<TestPlayer>({
        core: { groups: { has: async (player, key) => memberships.get(Number(typeof player === "object" ? player.id : player))?.has(key) || false } },
        config: {
            defaultTtl: 600,
            maxTtl: 900,
            maxMarkersPerResource: 4,
            showAllPlayers: false,
            houseTint: true,
            playerBlipScale: 1.2,
            hideBaseIcon: false,
            enableCommands: false,
            command: "blips",
        },
        players: () => connected,
        events: { emit() {}, emitAllClients: (name, raw) => broadcasts.push({ name, payload: typeof raw === "string" ? JSON.parse(raw) : raw }) },
        logger: { warn() {}, error() {} },
        now: () => 1000,
        setTimer: (handler) => {
            const timer = { handler, cleared: false };
            timers.push(timer);
            return timer as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: (timer) => { (timer as unknown as { cleared: boolean }).cleared = true; },
    });

    const publicMarker = await service.markers.upsert({
        resource: "hmp-test",
        id: "shop",
        kind: "marker",
        position: { x: 10, y: 20, z: 30 },
        icon: "UI_T_MiniMap_Waypoint",
        label: "Shop",
        ttl: 0,
    });
    assert.strictEqual(publicMarker.key, "hmp:hmp-test:shop");
    assert.strictEqual(publicMarker.ttl, 900, "maxTtl clamps requested permanence");
    assert.ok(connected.every((player) => player.messages.some((message) => message.name === "hmp-blips:set")));

    first.messages.length = 0;
    second.messages.length = 0;
    await service.markers.upsert({ resource: "hmp-test", id: "private", kind: "circle", position: { x: 0, y: 0, z: 0 }, radius: 80, ttl: 30, audience: [first] });
    assert.ok(first.messages.some((message) => message.name === "hmp-blips:set"));
    assert.ok(!second.messages.some((message) => message.name === "hmp-blips:set" && String((message.payload as { key?: string })?.key || "").endsWith("private")));
    await service.markers.upsert({ resource: "hmp-test", id: "private", kind: "circle", position: { x: 1, y: 2, z: 3 }, radius: 100, ttl: 30, audience: [second] });
    assert.ok(first.messages.some((message) => message.name === "hmp-blips:remove"));
    assert.ok(second.messages.some((message) => message.name === "hmp-blips:set"));
    assert.strictEqual(timers[1].cleared, true, "upsert disarms the previous ttl");

    first.messages.length = 0;
    third.messages.length = 0;
    await service.markers.upsert({
        resource: "hmp-test",
        id: "castle-only",
        kind: "marker",
        position: { x: 50, y: 60, z: 70 },
        areaId: "Hogwarts",
        audience: { groups: [{ key: "job:auror" }] },
    });
    assert.ok(first.messages.some((message) => message.name === "hmp-blips:set"));
    assert.ok(!third.messages.some((message) => message.name === "hmp-blips:set" && String((message.payload as { key?: string })?.key || "").endsWith("castle-only")));

    await service.players.track({
        resource: "hmp-test",
        id: "aurors",
        subjects: { groups: [{ key: "job:auror" }] },
        audience: { groups: [{ key: "job:auror" }] },
        color: [0.2, 0.5, 1],
        priority: 10,
        sameArea: true,
    });
    const firstView = [...first.messages].reverse().find((message) => message.name === "hmp-blips:players")?.payload as { visible: number[]; colors: Record<string, number[]> };
    assert.deepStrictEqual(firstView.visible, [2]);
    assert.deepStrictEqual(firstView.colors[2], [0.2, 0.5, 1, 1]);
    const thirdView = [...third.messages].reverse().find((message) => message.name === "hmp-blips:players")?.payload as { visible: number[] };
    assert.deepStrictEqual(thirdView.visible, []);

    await service.players.track({ resource: "hmp-test", id: "dispatch", subjects: [second], audience: [first], color: [1, 0, 0, 1], priority: 20 });
    const priorityView = [...first.messages].reverse().find((message) => message.name === "hmp-blips:players")?.payload as { colors: Record<string, number[]> };
    assert.deepStrictEqual(priorityView.colors[2], [1, 0, 0, 1]);
    second.area = "Hogsmeade";
    await service.players.refresh(first);
    const movedView = [...first.messages].reverse().find((message) => message.name === "hmp-blips:players")?.payload as { visible: number[] };
    assert.deepStrictEqual(movedView.visible, [2], "dispatch group still includes the subject despite the area-scoped auror group");
    await service.players.untrack("dispatch", "hmp-test");
    const areaView = [...first.messages].reverse().find((message) => message.name === "hmp-blips:players")?.payload as { visible: number[] };
    assert.deepStrictEqual(areaView.visible, []);

    const failed = await service.markers.upsert({
        resource: "hmp-fail",
        id: "closed",
        kind: "marker",
        position: { x: 0, y: 0, z: 0 },
        audience: () => { throw new Error("resolver down"); },
    });
    assert.strictEqual(failed.scoped, true);
    assert.ok(!connected.some((player) => [...player.messages].reverse().some((message) => message.name === "hmp-blips:set" && (message.payload as { key?: string })?.key === failed.key)));

    const cleanupCount = await service.cleanup("hmp-test");
    assert.ok(cleanupCount >= 4);
    assert.strictEqual(service.markers.list("hmp-test").length, 0);
    assert.strictEqual(service.players.list("hmp-test").length, 0);
    assert.ok(broadcasts.some((event) => event.name === "hmp-blips:remove"));

    const nativeCalls: Array<{ name: string; args: unknown[] }> = [];
    const reports: Array<{ name: string; payload: unknown }> = [];
    const client = createBlipsClient({
        emitServer: (name, payload) => { reports.push({ name, payload: JSON.parse(payload) }); },
        native: {
            setMarker: (...args) => { nativeCalls.push({ name: "marker", args }); return true; },
            setCircle: (...args) => { nativeCalls.push({ name: "circle", args }); return true; },
            remove: (...args) => { nativeCalls.push({ name: "remove", args }); return true; },
            clear: () => { nativeCalls.push({ name: "clear", args: [] }); },
            pulseCircle: (...args) => { nativeCalls.push({ name: "pulse", args }); return true; },
            setPlayerColor: (...args) => { nativeCalls.push({ name: "color", args }); },
            setTrackedPlayers: (...args) => { nativeCalls.push({ name: "tracked", args }); },
            trackAllPlayers: (...args) => { nativeCalls.push({ name: "all", args }); },
            setHouseTint: (...args) => { nativeCalls.push({ name: "tint", args }); return true; },
            setBlipScale: (...args) => { nativeCalls.push({ name: "scale", args }); },
            hideBaseIcon: (...args) => { nativeCalls.push({ name: "base", args }); },
        },
        logger: { info() {}, warn() {} },
        now: () => 1000,
    });
    assert.strictEqual(client.set({ key: "one", kind: "marker", x: 1, y: 2, z: 3, icon: "icon", label: "label", showOnHud: false, showDistance: false }), true);
    assert.deepStrictEqual(nativeCalls.find((call) => call.name === "marker")?.args, ["one", 1, 2, 3, "icon", "label", false, false]);
    assert.strictEqual(client.set({ key: "area", kind: "circle", x: 0, y: 0, z: 0, radius: 50 }), true);
    assert.strictEqual(client.pulse({ key: "area", pulse: false }), true);
    assert.strictEqual(client.replay({ blips: [{ key: "two", kind: "marker", x: 4, y: 5, z: 6 }] }), 1);
    assert.strictEqual(client.status().markers, 1);
    assert.strictEqual(client.setPlayers({ all: false, visible: [2], colors: { 2: [0.1, 0.2, 0.3, 1] }, houseTint: true, scale: 1.2, hideBaseIcon: true }), true);
    assert.deepStrictEqual(nativeCalls.find((call) => call.name === "tracked")?.args, [[2]]);
    client.setPlayers({ all: true, visible: [], colors: {} });
    assert.ok(nativeCalls.some((call) => call.name === "color" && call.args.length === 1));
    assert.strictEqual(client.reportWaypoint({ x: 1, y: 2, z: 3, target: "FT_HW_GreatHall" }), true);
    assert.strictEqual(client.reportWaypoint(null), true);
    assert.deepStrictEqual(reports, [
        { name: "hmp-blips:waypoint", payload: { waypoint: { x: 1, y: 2, z: 3, target: "FT_HW_GreatHall" } } },
        { name: "hmp-blips:waypoint", payload: { waypoint: null } },
    ]);
    client.stop();
    assert.strictEqual(client.status().state, "stopped");
    assert.strictEqual(client.reportWaypoint({ x: 1, y: 2, z: 3, target: null }), false);
    service.stop();
}

async function waypoints(): Promise<void> {
    const sharer = makePlayer(1);
    const friend = makePlayer(2);
    const stranger = makePlayer(3);
    const connected = [sharer, friend, stranger];
    const emitted: Array<{ name: string; payload: unknown }> = [];
    const broadcasts: Array<{ name: string; payload: unknown }> = [];
    const service = createBlipsService<TestPlayer>({
        core: { groups: { has: async () => false } },
        config: { defaultTtl: 600, maxTtl: 0, maxMarkersPerResource: 4, showAllPlayers: true, houseTint: true, playerBlipScale: 1, hideBaseIcon: false, enableCommands: false, command: "blips" },
        players: () => connected,
        events: { emit: (name, payload) => emitted.push({ name, payload }), emitAllClients: (name, payload) => broadcasts.push({ name, payload }) },
        logger: { warn() {}, error() {} },
        now: () => 1000,
        setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
        clearTimer() {},
    });
    const lastSet = (player: TestPlayer) => [...player.messages].reverse().find((message) => message.name === "hmp-blips:set")?.payload as Record<string, unknown> | undefined;

    // Until the sharer's client reports one (never, on a host without Blips.waypoint), a share shows nothing.
    assert.strictEqual(service.waypoints.get(sharer), null);
    const info = await service.waypoints.share({ resource: "hmp-party", id: "lead", player: sharer, audience: [sharer, friend] });
    assert.deepStrictEqual(info, { resource: "hmp-party", id: "lead", key: "hmp:hmp-party:lead", playerId: 1, shown: false });
    assert.strictEqual(lastSet(friend), undefined);

    assert.strictEqual(await service.reportWaypoint(sharer, "{"), false);
    assert.strictEqual(await service.reportWaypoint(sharer, { waypoint: { x: "here", y: 0, z: 0 } }), false);
    assert.strictEqual(await service.reportWaypoint(sharer, JSON.stringify({})), false);
    assert.strictEqual(emitted.length, 0);

    // A placed waypoint is kept with the map it is in, announced, and shown to the audience but never the sharer.
    assert.strictEqual(await service.reportWaypoint(sharer, JSON.stringify({ waypoint: { x: 10, y: 20, z: 30, target: "FT_HW_GreatHall" } })), true);
    const placed = { x: 10, y: 20, z: 30, target: "FT_HW_GreatHall", areaId: "Hogwarts" };
    assert.deepStrictEqual(service.waypoints.get(1), placed);
    assert.deepStrictEqual(emitted, [{ name: "hmp:blips:waypoint", payload: { player: sharer, waypoint: placed, previous: null } }]);
    assert.deepStrictEqual(lastSet(friend), { key: "hmp:hmp-party:lead", kind: "marker", x: 10, y: 20, z: 30, icon: "UI_T_MiniMap_Waypoint", label: "Player1", showOnHud: true, showDistance: true });
    assert.strictEqual(lastSet(sharer), undefined);
    assert.strictEqual(lastSet(stranger), undefined);
    assert.strictEqual(service.markers.get("lead", "hmp-party")?.areaId, "Hogwarts");
    assert.strictEqual(service.waypoints.list()[0].shown, true);
    assert.strictEqual(await service.reportWaypoint(sharer, { waypoint: { x: 10, y: 20, z: 30, target: "FT_HW_GreatHall" } }), false, "the same waypoint is no change");

    // Moving it moves the marker; lifting it hides the marker and keeps the share.
    await service.reportWaypoint(sharer, { waypoint: { x: 40, y: 50, z: 60, target: null } });
    assert.deepStrictEqual([lastSet(friend)?.x, lastSet(friend)?.y, lastSet(friend)?.z], [40, 50, 60]);
    await service.reportWaypoint(sharer, { waypoint: null });
    assert.strictEqual(service.waypoints.get(sharer), null);
    assert.deepStrictEqual((emitted.at(-1)?.payload as { previous: unknown }).previous, { x: 40, y: 50, z: 60, target: null, areaId: "Hogwarts" });
    assert.strictEqual(service.markers.get("lead", "hmp-party"), null);
    assert.deepStrictEqual(broadcasts.at(-1), { name: "hmp-blips:remove", payload: JSON.stringify({ key: "hmp:hmp-party:lead" }) });
    assert.strictEqual(service.waypoints.list()[0].shown, false);

    // The sharer leaving ends their shares.
    await service.reportWaypoint(sharer, { waypoint: { x: 1, y: 2, z: 3, target: null } });
    assert.ok(service.markers.get("lead", "hmp-party"));
    service.disconnect(sharer);
    assert.deepStrictEqual(service.waypoints.list(), []);
    assert.strictEqual(service.markers.get("lead", "hmp-party"), null);

    // Unsharing, and the owning resource stopping, end a share too.
    await service.reportWaypoint(friend, { waypoint: { x: 7, y: 8, z: 9, target: null } });
    await service.waypoints.share({ resource: "hmp-party", id: "rally", player: 2, audience: "all", label: "Rally" });
    assert.strictEqual(lastSet(stranger)?.label, "Rally");
    assert.strictEqual(service.waypoints.unshare("rally", "hmp-party"), true);
    assert.strictEqual(service.waypoints.unshare("rally", "hmp-party"), false);
    assert.strictEqual(service.markers.get("rally", "hmp-party"), null);
    await service.waypoints.share({ resource: "hmp-party", id: "rally", player: friend, audience: [stranger] });
    await service.cleanup("hmp-party");
    assert.deepStrictEqual(service.waypoints.list(), []);
    assert.strictEqual(service.markers.list("hmp-party").length, 0);

    await assert.rejects(service.waypoints.share({ resource: "hmp-party", id: "gone", player: 99, audience: "all" }), /must be connected/);
    await assert.rejects(service.waypoints.share({ resource: "hmp-party", id: "open", player: friend } as never), /audience is required/);
    await assert.rejects(service.waypoints.share({ resource: "hmp-party", id: "long", player: friend, audience: "all", label: "x".repeat(121) }), /label/);
    assert.deepStrictEqual([service.status().waypoints, service.status().waypointShares], [1, 0]);
    service.stop();
    assert.strictEqual(service.waypoints.get(friend), null);
}

run().then(waypoints).then(() => console.log("hmp-blips tests passed"));
