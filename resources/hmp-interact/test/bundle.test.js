const assert = require("node:assert");
const path = require("node:path");

const serverExports = new Map();
const serverHandlers = new Map();
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const core = { characters: { active: () => null }, groups: { has: async () => true } };
const inventory = { inventory: { has: async () => true } };
const ui = { notify: () => true, context: async () => null, progress: async () => true };
global.Exports = { register: (name, value) => serverExports.set(name, value) };
global.Imports = { get: (name) => {
    if (name === "hmp-lib") return { logger: { create: () => logger } };
    if (name === "hmp-core") return core;
    if (name === "hmp-inventory") return inventory;
    if (name === "hmp-ui") return ui;
    throw new Error(`Unexpected import ${name}`);
} };
global.PlayerManager = { getAll: () => [] };
global.WorldObject = { create: () => ({}), destroy: () => true };
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

require(path.resolve(__dirname, "..", "dist", "client.js"));
assert.deepStrictEqual([...clientExports.keys()], ["setEnabled", "status"]);
assert.ok(clientHandlers.has("hmp-interact:snapshot"));
assert.ok(clientHandlers.has("anchorReleased"));
assert.strictEqual(typeof keyHandler, "function");
clientHandlers.get("hmp-interact:snapshot")({ revision: 1, interactions: [
    { id: "smoke", label: "Smoke", position: { x: 0, y: 0, z: 0 }, promptDistance: 100, promptOffsetZ: 50, priority: 0 },
] });
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
