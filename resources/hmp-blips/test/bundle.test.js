const assert = require("node:assert");
const path = require("node:path");

const serverExports = new Map();
const serverHandlers = new Map();
const broadcasts = [];
const player = {
    id: 1,
    nickname: "Smoke",
    position: { x: 1, y: 2, z: 3 },
    virtualWorld: 0,
    emit() {},
    sendChat() {},
    location: () => ({ areaId: "Hogwarts", regionId: "GreatHall", destinationId: null, x: 1, y: 2, z: 3, yaw: 0, revision: 1 }),
};
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const router = { register() {}, handle() {} };
global.Exports = { register: (name, value) => serverExports.set(name, value) };
global.Imports = { get: (name) => {
    if (name === "hmp-lib") return {
        logger: { create: () => logger },
        text: { clean: (value) => String(value).trim() },
        config: { load: (_path, options) => options.defaults, env: { boolean: (_value, fallback) => fallback } },
        command: { createRouter: () => router },
    };
    if (name === "hmp-core") return { groups: { has: async () => true } };
    throw new Error(`Unexpected import ${name}`);
} };
global.PlayerManager = { getAll: () => [player] };
global.Events = {
    on: (name, handler) => serverHandlers.set(name, handler),
    onClient: (name, handler) => serverHandlers.set(`client:${name}`, handler),
    emit() {},
    emitAllClients: (name, payload) => broadcasts.push({ name, payload }),
};
require(path.resolve(__dirname, "..", "dist", "server.js"));
assert.deepStrictEqual([...serverExports.keys()], ["markers", "players", "waypoints", "status"]);
assert.ok(serverHandlers.has("client:hmp-blips:ready"));
assert.ok(serverHandlers.has("client:hmp-blips:waypoint"));
assert.ok(serverHandlers.has("playerLocationChanged"));
assert.ok(broadcasts.some((entry) => entry.name === "hmp-blips:clear"));

void (async () => {
    await serverHandlers.get("client:hmp-blips:waypoint")(player, JSON.stringify({ waypoint: { x: 4, y: 5, z: 6, target: null } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepStrictEqual(serverExports.get("waypoints").get(player), { x: 4, y: 5, z: 6, target: null, areaId: "Hogwarts" });

    const clientBundle = path.resolve(__dirname, "..", "dist", "client.js");
    function loadClient(waypoint) {
        delete require.cache[clientBundle];
        const loaded = { exports: new Map(), handlers: new Map(), emits: [], nativeCalls: [] };
        global.Exports = { register: (name, value) => loaded.exports.set(name, value) };
        global.Imports = { get: () => ({ logger: { create: () => logger } }) };
        global.Events = {
            on: (name, handler) => loaded.handlers.set(name, handler),
            emitServer: (name, payload) => loaded.emits.push({ name, payload }),
        };
        global.Blips = {
            setMarker: (...args) => { loaded.nativeCalls.push(["marker", ...args]); return true; },
            setCircle: (...args) => { loaded.nativeCalls.push(["circle", ...args]); return true; },
            remove: () => true,
            clear() {},
            pulseCircle: () => true,
            setPlayerColor() {},
            setTrackedPlayers() {},
            trackAllPlayers() {},
            setHouseTint: () => true,
            setBlipScale() {},
            hideBaseIcon() {},
            ...(waypoint === undefined ? {} : { waypoint: () => waypoint }),
        };
        require(clientBundle);
        return loaded;
    }

    // A host with waypoint reads reports the waypoint already placed, then each change.
    const client = loadClient({ x: 1, y: 2, z: 3, target: "FT_HW_GreatHall" });
    assert.deepStrictEqual([...client.exports.keys()], ["status"]);
    assert.deepStrictEqual(client.emits, [
        { name: "hmp-blips:ready", payload: "{}" },
        { name: "hmp-blips:waypoint", payload: JSON.stringify({ waypoint: { x: 1, y: 2, z: 3, target: "FT_HW_GreatHall" } }) },
    ]);
    client.handlers.get("waypointChanged")(null, { x: 1, y: 2, z: 3, target: "FT_HW_GreatHall" });
    assert.deepStrictEqual(client.emits.at(-1), { name: "hmp-blips:waypoint", payload: JSON.stringify({ waypoint: null }) });
    client.handlers.get("hmp-blips:set")({ key: "smoke", kind: "marker", x: 1, y: 2, z: 3 });
    assert.ok(client.nativeCalls.some((entry) => entry[0] === "marker"));
    client.handlers.get("resourceStop")("hmp-blips");
    assert.strictEqual(client.exports.get("status")().state, "stopped");

    // An older host has no Blips.waypoint: nothing is reported.
    const older = loadClient(undefined);
    assert.deepStrictEqual(older.emits.map((entry) => entry.name), ["hmp-blips:ready"]);
    assert.ok(!older.handlers.has("waypointChanged"));
    console.log("hmp-blips bundle contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
