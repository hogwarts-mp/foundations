const assert = require("node:assert");
const path = require("node:path");

const exportsSeen = new Map();
const handlers = new Map();
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
const inventory = {
    items: { get: (name) => name === "native:galleons" ? { name, label: "Galleons" } : null },
    inventory: { count: async () => 0, has: async () => false, add: async (_player, _name, amount) => amount, remove: async (_player, _name, amount) => amount },
};
global.Exports = { register: (name, value) => exportsSeen.set(name, value) };
global.Imports = { get: (name) => {
    if (name === "hmp-lib") return { logger: { create: () => logger }, config: { load: () => ({ shops: [] }) } };
    if (name === "hmp-mysql") return database;
    if (name === "hmp-core") return { characters: { active: () => ({ id: 1 }) }, groups: { has: async () => true } };
    if (name === "hmp-inventory") return inventory;
    if (name === "hmp-interact") return { register: () => () => true };
    if (name === "hmp-ui") return { notify: () => true, context: async () => null, input: async () => null, alert: async () => null };
    throw new Error(`Unexpected import ${name}`);
} };
global.Events = { on: (name, handler) => handlers.set(name, handler), emit() {} };

require(path.resolve(__dirname, "..", "dist", "server.js"));
assert.deepStrictEqual([...exportsSeen.keys()], ["shops", "currencies", "transactions", "stock", "status"]);
assert.ok(handlers.has("playerDisconnect"));
assert.ok(handlers.has("resourceStop"));
assert.strictEqual(exportsSeen.get("currencies").get("galleons").label, "Galleons");
console.log("hmp-shops bundle contract passed");
