const assert = require("node:assert");
const fs = require("node:fs");
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
global.Exports = { register: (name, value) => exportsSeen.set(name, value) };
global.Imports = { get: (name) => {
    if (name === "hmp-lib") return { logger: { create: () => logger } };
    if (name === "hmp-mysql") return database;
    if (name === "hmp-core") return { characters: { active: () => ({ id: 1, name: "Test" }) }, groups: { has: async () => true } };
    if (name === "hmp-inventory") return {
        items: { get: (item) => item === "native:galleons" ? { name: item } : null },
        inventory: { count: async () => 0, has: async () => false, add: async (_player, _item, amount) => amount, remove: async (_player, _item, amount) => amount },
    };
    if (name === "hmp-ui") return { notify: () => true, close: () => true, context: async () => null, input: async () => null, alert: async () => null };
    throw new Error(`Unexpected import ${name}`);
} };
global.Events = { on: (name, handler) => handlers.set(name, handler), emit() {} };

require(path.resolve(__dirname, "..", "dist", "server.js"));
assert.deepStrictEqual([...exportsSeen.keys()], ["accounts", "organizations", "currencies", "transactions", "cash", "providers", "ui", "status"]);
assert.ok(handlers.has("playerDisconnect"));
assert.ok(handlers.has("hmp:character:may-switch"));
assert.ok(handlers.has("hmp:character:unloading"));
assert.ok(handlers.has("resourceStop"));
assert.strictEqual(exportsSeen.get("currencies").get("galleons").cashItem, "native:galleons");
assert.strictEqual(exportsSeen.get("providers").shops({ resource: "test" }).id, "bank-galleons");
const clientSource = fs.readFileSync(path.resolve(__dirname, "..", "dist", "client.js"), "utf8");
assert.ok(clientSource.includes("client dependency shim ready"));
console.log("hmp-banking bundle contract passed");
