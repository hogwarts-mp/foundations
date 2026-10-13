const assert = require("node:assert");
const path = require("node:path");

const exportsMap = new Map();
const serverHandlers = new Map();
const clientHandlers = new Map();
const activity = {
    definitions: { register: () => async () => 0 },
    sessions: {
        create: async () => ({ id: "activity-1", participants: [] }), get: () => null,
        join: async () => ({}), start: async () => ({}), complete: async () => ({}), cancel: async () => ({}),
    },
    status: () => ({ state: "ready" }),
};
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const services = {
    "hmp-lib": { logger: { create: () => logger }, input: { shortcuts: { register: () => () => true }, cleanup() {} } },
    "hmp-core": { characters: { active: () => null }, metadata: { getCharacter: async () => ({}), setCharacter: async () => ({}) } },
    "hmp-activities": activity,
    "hmp-ui": { notify() {}, close() {}, context: async () => null, input: async () => null },
    "hmp-houses": { membership: { sync: async () => null }, status: () => ({ state: "ready" }) },
    "hmp-inventory": { native: { list: () => [], give: async () => 1 } },
    "hmp-interact": { register: () => () => true },
    "hmp-audio": { sounds: { playForAll: () => null, playAt: () => null, playForPlayer: () => null, stop: () => true, release: () => 0 } },
    "hmp-blips": { markers: { clear: () => 0, upsert: async (value) => value, remove: () => true } },
    "hmp-world": { policy: { restore: () => true }, status: () => ({ state: "ready" }) },
};

global.Imports = { get: (name) => services[name] };
global.Exports = { register: (name, value) => exportsMap.set(name, value) };
global.PlayerManager = { getAll: () => [], getById: () => null };
global.StateTable = { set() {} };
global.Events = {
    on: (name, handler) => serverHandlers.set(name, handler),
    onClient: (name, handler) => serverHandlers.set(`client:${name}`, handler),
    listenerCount: () => 0,
    emit() {}, emitServer() {},
};
const realSetInterval = global.setInterval;
global.setInterval = () => ({ unref() {} });
require(path.resolve(__dirname, "..", "dist", "server.js"));
assert.deepStrictEqual([...exportsMap.keys()], ["status", "call", "start", "stop"]);
assert.ok(serverHandlers.has("client:quidditch:pickup"));
assert.ok(serverHandlers.has("client:quidditch:tackle"));
assert.strictEqual(exportsMap.get("status")().state, "idle");

global.Events = { on: (name, handler) => clientHandlers.set(name, handler), emitServer() {} };
global.Game = { notify() {} };
global.World = { worldObjectState: () => null };
global.Broom = {};
global.LocalPlayer = {};
global.Web = {};
require(path.resolve(__dirname, "..", "dist", "client.js"));
assert.ok(clientHandlers.has("quidditch:setup"));
assert.ok(clientHandlers.has("resourceStop"));
global.setInterval = realSetInterval;
console.log("hmp-quidditch bundle contract passed");
