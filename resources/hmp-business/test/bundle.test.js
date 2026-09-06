const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const exportsSeen = new Map();
const handlers = new Map();
const clientHandlers = new Map();
const localHandlers = new Map();
const webHandlers = new Map();
const emittedToServer = [];
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const database = {
    transaction: async (work) => typeof work === "function" ? work(database) : [],
    migrate: async () => ({ applied: [], skipped: [1], currentVersion: 1 }),
    update: async () => 1,
    query: async () => [],
    single: async () => null,
    scalar: async () => null,
    insert: async () => 1,
};
global.Exports = { register: (name, value) => exportsSeen.set(name, value) };
global.Imports = { get: (name) => {
    if (name === "hmp-lib") return {
        logger: { create: () => logger },
        config: { load: () => ({}) },
        player: { byId: () => null },
        position: { within: () => false },
        command: { createRouter: () => ({ register: () => () => true, handle: async () => false }) },
        rateLimit: { create: () => ({ allow: () => true }) },
        input: { controls: { acquire: () => ({ release: () => true }) } },
    };
    if (name === "hmp-mysql") return database;
    if (name === "hmp-core") return { characters: { active: () => ({ id: 1 }) }, groups: { has: async () => true } };
    if (name === "hmp-inventory") return { items: { get: () => null }, inventory: { count: async () => 0, has: async () => false, add: async (_p, _n, amount) => amount, remove: async (_p, _n, amount) => amount } };
    if (name === "hmp-interact") return { register: () => () => true };
    if (name === "hmp-ui") return { notify: () => true, context: async () => null, input: async () => null, alert: async () => null, close: () => true };
    if (name === "hmp-banking") return { accounts: { personal: async () => ({ id: 1, balance: 0 }), organization: async () => null }, organizations: { register: () => () => true, get: () => null }, currencies: { get: () => ({ id: "galleons", label: "Galleons" }) }, transactions: { transfer: async () => ({ status: "completed" }) } };
    if (name === "hmp-shops") return { shops: { register: () => () => true }, currencies: { register: () => () => true }, stock: { get: async () => 0, set: async (_s, _o, q) => q, adjust: async () => 0 } };
    if (name === "hmp-jobs") return { jobs: { get: () => null }, permissions: { has: async () => false }, duty: { list: () => [], toggle: async () => null } };
    throw new Error(`Unexpected import ${name}`);
} };
global.Events = { on: (name, handler) => handlers.set(name, handler), onClient: (name, handler) => clientHandlers.set(name, handler), emit() {} };
global.PlayerManager = { getById: () => null };

require(path.resolve(__dirname, "..", "dist", "server.js"));
assert.deepStrictEqual([...exportsSeen.keys()], ["businesses", "shops", "offers", "stock", "books", "ui", "audit", "status"]);
assert.ok(handlers.has("hmp:jobs:duty"));
assert.ok(handlers.has("hmp:shop:purchased"));
assert.ok(handlers.has("playerDisconnect"));
assert.ok(handlers.has("resourceStop"));
assert.ok(handlers.has("chatCommand"));
assert.ok(clientHandlers.has("hmp-business:action"));
assert.strictEqual(exportsSeen.get("status")().state, "starting");

global.Events = { on: (name, handler) => localHandlers.set(name, handler), emitServer: (name, payload) => emittedToServer.push({ name, payload }) };
global.Imports = { get: () => ({ input: { controls: { acquire: () => ({ release: () => true }) } } }) };
global.Web = { createView: () => 1, on: (_view, name, handler) => webHandlers.set(name, handler), emit() {}, showView() {}, hideView() {}, focusView() {} };
global.Game = { notify() {} };
require(path.resolve(__dirname, "..", "dist", "client.js"));
assert.ok(localHandlers.has("hmp-business:open"));
localHandlers.get("hmp-business:open")(JSON.stringify({ businesses: [], shops: [], offers: [] }));
assert.ok(webHandlers.has("action"));
assert.ok(emittedToServer.some((event) => event.name === "hmp-business:ready"));
assert.ok(fs.existsSync(path.resolve(__dirname, "..", "dist", "index.html")));
console.log("hmp-business bundle contract passed");
