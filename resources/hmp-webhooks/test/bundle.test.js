const assert = require("node:assert");
const path = require("node:path");

const exported = new Map();
const handlers = new Map();
const logger = { debug() {}, info() {}, warn() {}, error() {} };
delete process.env.HMP_WEBHOOKS_ENABLED;
delete process.env.HMP_WEBHOOKS_DISCORD_URL;

global.Exports = { register: (name, value) => exported.set(name, value) };
global.Imports = { get: (name) => {
    if (name !== "hmp-lib") throw new Error(`Unexpected import ${name}`);
    return {
        logger: { create: () => logger },
        config: {
            load: (_path, options) => options.defaults,
            env: { boolean: (_value, fallback) => fallback },
        },
    };
} };
global.Events = { on: (name, handler) => handlers.set(name, handler) };

require(path.resolve(__dirname, "..", "dist", "server.js"));

assert.deepStrictEqual([...exported.keys()], ["send", "status"]);
assert.ok(handlers.has("hmp-gauntlet:complete"));
assert.ok(handlers.has("hmp:activities:completed"));
assert.ok(handlers.has("hmp:spells:cast"));
assert.ok(handlers.has("resourceStop"));
assert.strictEqual(exported.get("status")().state, "ready");
assert.strictEqual(exported.get("status")().enabled, false);
assert.strictEqual(exported.get("send")("discord", { content: "disabled" }), false);
handlers.get("resourceStop")("hmp-webhooks");
assert.strictEqual(exported.get("status")().state, "stopped");
console.log("hmp-webhooks bundle contract passed");
