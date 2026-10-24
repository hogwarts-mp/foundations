const assert = require("node:assert");
const path = require("node:path");

const serverExports = new Map();
const serverHandlers = new Map();
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const core = { characters: { active: () => null }, groups: { has: async () => true } };
const inventory = { inventory: { has: async () => true } };
const ui = { notify: () => true, context: async () => null, progress: async () => true };
const commands = new Map();
const lib = {
    logger: { create: () => logger },
    text: { clean: (value) => String(value).trim() },
    // As the example config ships it: the closed-test command on.
    config: { load: (_path, options) => ({ ...options.defaults, enableCommands: true }), env: { boolean: (_value, fallback) => fallback } },
    command: { createRouter: () => ({ register: (name, _spec, handler) => { commands.set(name, handler); return () => true; }, handle() {} }) },
};
global.Exports = { register: (name, value) => serverExports.set(name, value) };
global.Imports = { get: (name) => {
    if (name === "hmp-lib") return lib;
    if (name === "hmp-core") return core;
    if (name === "hmp-inventory") return inventory;
    if (name === "hmp-ui") return ui;
    throw new Error(`Unexpected import ${name}`);
} };
global.PlayerManager = { getAll: () => [] };
const worldObjects = [];
global.WorldObject = { create: (key, model, options) => { worldObjects.push({ key, model, options }); return {}; }, destroy: () => true };
global.Events = {
    on: (name, handler) => serverHandlers.set(name, handler),
    onClient: (name, handler) => serverHandlers.set(`client:${name}`, handler),
    emit() {},
};

require(path.resolve(__dirname, "..", "dist", "server.js"));
assert.deepStrictEqual([...serverExports.keys()], ["register", "unregister", "get", "list", "trigger", "sync", "status"]);
assert.ok(serverHandlers.has("client:hmp-interact:ready"));
assert.ok(serverHandlers.has("client:hmp-interact:trigger"));
assert.ok(serverHandlers.has("client:hmp-interact:stand"));
serverExports.get("register")({
    id: "smoke.prop", resource: "smoke", label: "Prop", position: { x: 0, y: 0, z: 0 }, handler() {},
    object: { model: "/Game/Smoke.Smoke", streamRange: 20000, drawDistance: 0, material: "/Game/M_Smoke.M_Smoke" },
});
assert.deepStrictEqual([worldObjects[0].options.streamRange, worldObjects[0].options.drawDistance, worldObjects[0].options.material], [20000, 0, "/Game/M_Smoke.M_Smoke"]);
assert.ok(serverHandlers.has("chatCommand"));
const tester = { id: 3, position: { x: 0, y: 0, z: 0 }, messages: [], emit(name, payload) { this.messages.push({ name, payload }); } };
const replies = [];
commands.get("interact")({ player: tester, args: ["outlines"], reply: (message) => replies.push(message), usage: "/interact outlines [on|off]" });
const outlined = JSON.parse(tester.messages.at(-1).payload);
assert.deepStrictEqual([outlined.outlines, outlined.interactions[0].radius], [true, 250]);
assert.match(replies[0], /Outlining/);

const clientExports = new Map();
const clientHandlers = new Map();
const sentToServer = [];
const anchors = [];
let keyHandler = null;
let hidden = false;
const input = { shortcuts: { register: (definition) => { keyHandler = () => { if (!definition.when || definition.when()) definition.handler("f", "down"); }; return () => true; } } };
global.Exports = { register: (name, value) => clientExports.set(name, value) };
global.Events = {
    on: (name, handler) => clientHandlers.set(name, handler),
    emitServer: (name, payload) => sentToServer.push({ name, payload }),
};
global.Imports = { get: (name) => {
    if (name === "hmp-lib") return { input };
    throw new Error(`Unexpected client import ${name}`);
} };
global.Hud = { showPrompt() {}, hidePrompt: () => { hidden = true; } };
global.LocalPlayer = {
    getPosition: () => ({ x: 0, y: 0, z: 0 }),
    anchor: (at) => { anchors.push(["anchor", at]); return true; },
    releaseAnchor: (...exit) => { anchors.push(["release", ...exit]); return true; },
    playClip: () => true,
};
global.Game = { areControlsLocked: () => false };
const shapes = [];
global.Shapes = { create: (key) => { shapes.push(key); return true; }, destroy: () => true, destroyAll: () => { shapes.push("all"); return 0; } };

require(path.resolve(__dirname, "..", "dist", "client.js"));
assert.deepStrictEqual([...clientExports.keys()], ["setEnabled", "status"]);
assert.ok(clientHandlers.has("hmp-interact:snapshot"));
assert.ok(clientHandlers.has("anchorReleased"));
assert.strictEqual(typeof keyHandler, "function");
clientHandlers.get("hmp-interact:snapshot")({ revision: 1, outlines: true, interactions: [
    { id: "smoke", label: "Smoke", position: { x: 0, y: 0, z: 0 }, promptDistance: 100, promptOffsetZ: 50, priority: 0, radius: 250 },
] });
assert.deepStrictEqual(shapes, ["radius:smoke", "prompt:smoke"]);
clientHandlers.get("hmp-interact:snapshot")({ revision: 1, interactions: [
    { id: "smoke", label: "Smoke", position: { x: 0, y: 0, z: 0 }, promptDistance: 100, promptOffsetZ: 50, priority: 0 },
] });
assert.deepStrictEqual(shapes.at(-1), "all", "outlines off clears them");
const stands = () => sentToServer.filter((message) => message.name === "hmp-interact:stand").length;
clientHandlers.get("hmp-interact:seat")(JSON.stringify({ id: "smoke", position: { x: 0, y: 50, z: -90 }, exit: { x: 0, y: 100, z: -90 } }));
assert.deepStrictEqual(anchors, [["anchor", { x: 0, y: 50, z: -90, camera: true }]]);
keyHandler();
assert.deepStrictEqual(anchors.at(-1), ["release", { x: 0, y: 100, z: -90 }], "F stands a seated player up at the exit");
assert.strictEqual(stands(), 1);
delete global.LocalPlayer.anchor;
clientHandlers.get("hmp-interact:seat")(JSON.stringify({ id: "smoke", position: { x: 0, y: 50, z: -90 } }));
assert.strictEqual(stands(), 2, "a host without LocalPlayer.anchor hands the seat back");
clientHandlers.get("resourceStop")("hmp-interact");
assert.strictEqual(hidden, true);
console.log("hmp-interact bundle contract passed");
