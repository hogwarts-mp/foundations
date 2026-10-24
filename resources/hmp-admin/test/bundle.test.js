const assert = require("node:assert");
const path = require("node:path");

const exportsSeen = new Map();
const handlers = new Map();
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const database = {
    ready: async () => true,
    migrate: async () => ({ applied: [1] }),
    query: async () => [], single: async () => null,
    insert: async () => 1, update: async () => 1,
};
const core = {
    sessions: { get: () => null, all: () => [] },
    groups: { effective: async () => [] },
};
const ui = { notify: () => true, input: async () => null, context: async () => null, close: () => true };
const banking = { transactions: { pending: async () => [] } };
const spells = { catalog: { get: () => null, list: () => [] }, grants: { list: async () => [], grant: async () => false, revoke: async () => false } };
const characters = { appearance: { getTransmog: async () => "", listTransmogs: () => [], setTransmog: async () => true, clearTransmog: async () => true } };
const environmentState = { weather: "Clear", hour: 9, minute: 0, second: 0, day: 1, month: 9, year: 0, season: 2, timeScale: 1, revision: 1 };
const world = {
    environment: {
        baseline: () => ({ weather: "Clear", time: { hour: 9, minute: 0, second: 0, scale: 1 }, date: { day: 1, month: 9, year: 0 }, season: "autumn" }),
        state: () => ({ ...environmentState }), reset: () => ({ ...environmentState }),
        setWeather: () => true, setTime: () => true, setDate: () => true, setSeason: () => true, setTimeScale: () => true,
    },
};

global.Exports = { register: (name, value) => exportsSeen.set(name, value) };
global.Imports = {
    get(name) {
        if (name === "hmp-mysql") return database;
        if (name === "hmp-core") return core;
        if (name === "hmp-ui") return ui;
        if (name === "hmp-inventory") return { inventory: {} };
        if (name === "hmp-characters") return characters;
        if (name === "hmp-banking") return banking;
        if (name === "hmp-jobs") return { employment: {} };
        if (name === "hmp-spells") return spells;
        if (name === "hmp-world") return world;
        if (name === "hmp-lib") return {
            logger: { create: () => logger },
            config: { load: (_path, options) => ({ ...options.defaults }), env: { boolean: (_value, fallback) => fallback } },
            command: { createRouter: () => ({ register() {}, handle() {} }) },
        };
        throw new Error(`Unexpected import ${name}`);
    },
};
global.Events = { on: (name, handler) => handlers.set(name, handler) };
global.PlayerManager = { getAll: () => [], getById: () => null };
delete process.env.HMP_ADMIN_BOOTSTRAP_SECRET;

require(path.resolve(__dirname, "..", "dist", "server.js"));

assert.deepStrictEqual([...exportsSeen.keys()], ["permissions", "players", "actions", "moderation", "audit", "noclip", "status", "ui"]);
assert.strictEqual(exportsSeen.get("noclip").isActive(1), false);
assert.ok(handlers.has("hmp:session:ready"));
assert.ok(handlers.has("hmp:session:ended"));
assert.ok(handlers.has("hmp:groups:changed"));
assert.ok(handlers.has("playerDisconnect"));
assert.ok(handlers.has("playerTeleportComplete"));
assert.ok(handlers.has("playerMapTravelComplete"));
assert.ok(handlers.has("playerHoldEnded"));
assert.ok(handlers.has("playerMoveEnded"));
handlers.get("playerMoveEnded")({ id: 9, nickname: "Elsewhere" }, "rp-escort#1", "arrived");
assert.ok(handlers.has("chatCommand"));
assert.ok(handlers.has("resourceStart"));
assert.ok(handlers.has("resourceStop"));
const clientHandlers = new Map();
const intervals = [];
const keys = new Set();
const positions = [];
const visibility = [];
const input = [];
let collision = true;
const fallResets = [];
global.Events = { on: (name, handler) => clientHandlers.set(name, handler) };
global.setInterval = (callback, ms) => { intervals.push({ callback, ms }); return intervals.length; };
global.clearInterval = () => {};
global.Key = { isDown: (key) => keys.has(key) };
global.Game = { areControlsLocked: () => false, notify() {} };
global.Camera = { capture: () => ({ rotation: { pitch: 0, yaw: 0, roll: 0 } }) };
global.LocalPlayer = {
    getPosition: () => ({ x: 0, y: 0, z: 0 }),
    setPosition: (x, y, z) => { positions.push({ x, y, z }); return true; },
    setCollision: (enabled) => { collision = enabled; return true; },
    clearVelocity: () => true,
    resetFall: () => { fallResets.push({ collision }); return true; },
    getControlRotation: () => ({ pitch: 0, yaw: 0, roll: 0 }),
    setVisibility: (visible) => { visibility.push(visible); return true; },
    stopPlayerInput: () => { input.push("stop"); return true; },
    restorePlayerInput: () => { input.push("restore"); return true; },
    stateInfo: { setInvulnerableToDamage: () => true },
};
require(path.resolve(__dirname, "..", "dist", "client.js"));
assert.ok(clientHandlers.has("hmp-admin:noclip"));
assert.ok(clientHandlers.has("hmp-admin:freeze"));
assert.ok(clientHandlers.has("resourceStop"));
clientHandlers.get("hmp-admin:noclip")(JSON.stringify({ enabled: false }));
assert.deepStrictEqual(fallResets, [], "a disable outside no-clip leaves the game's fall alone");
clientHandlers.get("hmp-admin:freeze")(JSON.stringify({ frozen: false }));
assert.deepStrictEqual(input, [], "an unfrozen client leaves another resource's input stop alone");
clientHandlers.get("hmp-admin:freeze")(JSON.stringify({ frozen: true }));
clientHandlers.get("hmp-admin:freeze")(JSON.stringify({ frozen: false }));
clientHandlers.get("hmp-admin:freeze")(JSON.stringify({ frozen: false }));
assert.deepStrictEqual(input, ["stop", "restore"]);
clientHandlers.get("hmp-admin:freeze")(JSON.stringify({ frozen: true }));
const movement = { forward: "w", back: "s", left: "a", right: "d", up: "space", down: "ctrl", boost: "shift", slow: "alt" };
function flyOneTick(held, options = {}) {
    clientHandlers.get("hmp-admin:noclip")(JSON.stringify({ enabled: true, speed: 1000, boost: 3, slow: 0.25, tickMs: 10, movement, ...options }));
    keys.clear();
    for (const key of held) keys.add(key);
    intervals.at(-1).callback();
    return positions.at(-1).x;
}
assert.strictEqual(flyOneTick(["w"]), 10);
assert.strictEqual(flyOneTick(["w", "shift"]), 30);
assert.strictEqual(flyOneTick(["w", "alt"]), 2.5);
assert.strictEqual(flyOneTick(["w", "shift", "alt"]), 2.5);
clientHandlers.get("hmp-admin:noclip")(JSON.stringify({ enabled: false }));
assert.deepStrictEqual(visibility, [], "local hiding is opt-in");
flyOneTick([], { hideLocal: true });
assert.deepStrictEqual(visibility, [false]);
clientHandlers.get("hmp-admin:noclip")(JSON.stringify({ enabled: false }));
assert.deepStrictEqual(visibility, [false, true]);
flyOneTick([], { hideLocal: true });
clientHandlers.get("resourceStop")("hmp-admin");
assert.deepStrictEqual(visibility, [false, true, false, true]);
assert.deepStrictEqual(input, ["stop", "restore", "stop", "restore"], "stopping the resource restores a frozen client's input");
assert.deepStrictEqual(fallResets, [{ collision: false }, { collision: false }, { collision: false }], "every way out of no-clip resets the fall before collision returns");
assert.strictEqual(collision, true);

void (async () => {
    await handlers.get("resourceStart")("hmp-admin");
    assert.strictEqual(exportsSeen.get("status")().state, "ready");
    assert.strictEqual(exportsSeen.get("status")().bootstrapEnabled, false);
    assert.strictEqual(exportsSeen.get("status")().activeNoclip, 0);
    console.log("hmp-admin bundle contract passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
