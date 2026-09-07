const assert = require("node:assert");
const path = require("node:path");

const serverExports = new Map();
const serverHandlers = new Map();
const commands = new Map();
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const player = { id: 1, nickname: "Smoke", emitted: [], emit(name, payload) { this.emitted.push({ name, payload }); }, sendChat() {} };
const database = {
    ready: async () => true, migrate: async () => ({}), update: async () => 1,
    query: async () => [{ system_name: "breakables", state_key: "42", state_value: "broken", updated_by_account_id: null, updated_at: null }],
};
const core = { accounts: { getByPlayer: () => ({ id: 1 }) }, groups: { has: async () => true } };
global.Exports = { register: (name, value) => serverExports.set(name, value) };
global.Imports = { get: (name) => {
    if (name === "hmp-mysql") return database;
    if (name === "hmp-core") return core;
    if (name === "hmp-lib") return {
        logger: { create: () => logger },
        config: { load: (_path, options) => options.defaults, env: { boolean: (_value, fallback) => fallback } },
        rateLimit: { create: () => ({ allow: () => true }) },
        command: { createRouter: () => ({
            register: (name, _options, handler) => commands.set(name, handler),
            handle: async (p, message, command, args) => { const h = commands.get(command); if (!h) return false; await h({ player: p, message, command, invokedAs: command, args, usage: "usage", reply() { return true; } }); return true; },
        }) },
    };
    throw new Error(`Unexpected import ${name}`);
} };
global.PlayerManager = { getAll: () => [player] };
global.Events = {
    on: (name, handler) => serverHandlers.set(name, handler),
    onClient: (name, handler) => serverHandlers.set(`client:${name}`, handler),
};
require(path.resolve(__dirname, "..", "dist", "server.js"));
assert.deepStrictEqual([...serverExports.keys()], ["state", "systems", "breakables", "status"]);
assert.ok(serverHandlers.has("client:hmp-worldstate:ready"));
assert.ok(serverHandlers.has("client:hmp-worldstate:breakable"));
assert.ok(serverHandlers.has("hmp:character:loaded"));
assert.ok(serverHandlers.has("resourceStart"));
assert.ok(commands.has("worldstate"));

(async () => {
    serverHandlers.get("resourceStart")("hmp-worldstate");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const status = serverExports.get("status")();
    assert.strictEqual(status.state, "ready");
    assert.deepStrictEqual(status.systems, ["breakables"]);
    assert.strictEqual(status.entries, 1);
    assert.strictEqual(player.emitted.at(-1).name, "hmp-worldstate:sync");
    serverHandlers.get("client:hmp-worldstate:breakable")(player, JSON.stringify({ uid: 7, state: "repaired", cls: "BP_Statue_C" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(serverExports.get("breakables").get(7), "repaired");
    assert.strictEqual(player.emitted.at(-1).name, "hmp-worldstate:change");
    await serverHandlers.get("chatCommand")(player, "/worldstate status", "worldstate", ["status"]);
    serverHandlers.get("resourceStop")("hmp-worldstate");

    const clientExports = new Map();
    const clientHandlers = new Map();
    const clientEmits = [];
    const nativeCalls = [];
    global.Exports = { register: (name, value) => clientExports.set(name, value) };
    global.Events = {
        on: (name, handler) => clientHandlers.set(name, handler),
        emitServer: (name, payload) => clientEmits.push({ name, payload }),
    };
    global.Imports = { get: () => ({ logger: { create: () => logger } }) };
    global.Game = { notify() {} };
    global.Breakables = {
        arm: () => true, isInstalled: () => true, list: () => [], clear: () => nativeCalls.push("clear"), rescan: () => 0,
        setState: (uid, state) => { nativeCalls.push(`set ${uid} ${state}`); return true; },
        applyStates: (states) => { nativeCalls.push(`apply ${states.length}`); return states.length; },
    };
    require(path.resolve(__dirname, "..", "dist", "client.js"));
    assert.deepStrictEqual([...clientExports.keys()], ["status", "state", "breakables"]);
    assert.deepStrictEqual(clientEmits.map((event) => event.name), ["hmp-worldstate:ready"]);
    clientHandlers.get("hmp-worldstate:sync")(JSON.stringify({ systems: { breakables: [["42", "broken"]] } }));
    clientHandlers.get("hmp-worldstate:change")(JSON.stringify({ system: "breakables", key: "7", value: "repaired", by: 1 }));
    clientHandlers.get("breakableState")(9, "broken", "BP_Statue_C");
    assert.deepStrictEqual(nativeCalls, ["clear", "apply 1", "set 7 repaired"]);
    assert.strictEqual(clientEmits.at(-1).name, "hmp-worldstate:breakable");
    assert.strictEqual(clientExports.get("state").get("breakables", "7"), "repaired");
    clientHandlers.get("resourceStop")("hmp-worldstate");
    console.log("hmp-worldstate bundle contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
