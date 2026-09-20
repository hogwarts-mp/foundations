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

assert.deepStrictEqual([...exportsSeen.keys()], ["permissions", "players", "actions", "moderation", "audit", "status", "ui"]);
assert.ok(handlers.has("hmp:session:ready"));
assert.ok(handlers.has("hmp:session:ended"));
assert.ok(handlers.has("hmp:groups:changed"));
assert.ok(handlers.has("playerDisconnect"));
assert.ok(handlers.has("playerTeleportComplete"));
assert.ok(handlers.has("chatCommand"));
assert.ok(handlers.has("resourceStart"));
assert.ok(handlers.has("resourceStop"));
void (async () => {
    await handlers.get("resourceStart")("hmp-admin");
    assert.strictEqual(exportsSeen.get("status")().state, "ready");
    assert.strictEqual(exportsSeen.get("status")().bootstrapEnabled, false);
    assert.strictEqual(exportsSeen.get("status")().activeNoclip, 0);
    console.log("hmp-admin bundle contract passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
