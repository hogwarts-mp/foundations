const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const serverExports = new Map();
const serverHandlers = new Map();
const commands = new Map();
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const player = { id: 1, nickname: "Smoke", emit() {}, sendChat() {} };
const database = {
    ready: async () => true, migrate: async () => ({}), query: async () => [], update: async () => 1,
};
const core = {
    accounts: { getByPlayer: () => ({ id: 1 }) },
    groups: { has: async () => true },
    metadata: { getAccount: async () => [], setAccount: async (_id, _key, value) => value },
};
global.Exports = { register: (name, value) => serverExports.set(name, value) };
global.Imports = { get: (name) => {
    if (name === "hmp-mysql") return database;
    if (name === "hmp-core") return core;
    if (name === "hmp-lib") return {
        logger: { create: () => logger },
        config: { load: (_path, options) => options.defaults, env: { boolean: (_value, fallback) => fallback } },
        rateLimit: { create: () => ({ allow: () => true }) },
        command: { createRouter: () => ({
            register: (name, options, handler) => { commands.set(name, { options, handler }); return () => true; },
            handle: async () => false,
        }) },
    };
    throw new Error(`Unexpected import ${name}`);
} };
global.PlayerManager = { getAll: () => [player] };
global.Events = {
    on: (name, handler) => serverHandlers.set(name, handler),
    onClient: (name, handler) => serverHandlers.set(`client:${name}`, handler),
    emit() {},
};
require(path.resolve(__dirname, "..", "dist", "server.js"));
const menuPath = path.resolve(__dirname, "..", "dist", "menu.html");
assert.ok(fs.statSync(menuPath).size > 1000);
assert.ok(fs.statSync(path.resolve(__dirname, "..", "dist", "emote_assets.json")).size > 500000);
const menu = fs.readFileSync(menuPath, "utf8");
assert.match(menu, /allowToggle/);
assert.match(menu, /server-wide allowAll policy/);
assert.match(menu, /Click to set the server-level \/e alias/);
const menuScript = menu.match(/<script>([\s\S]*)<\/script>/)?.[1];
assert.ok(menuScript);
new Function(menuScript);
assert.deepStrictEqual([...serverExports.keys()], ["emotes", "aliases", "favorites", "ui", "status"]);
assert.ok(serverHandlers.has("client:hmp-emotes:ready"));
assert.ok(serverHandlers.has("client:hmp-emotes:alias-set"));
assert.ok(serverHandlers.has("client:hmp-emotes:allow-toggle"));
assert.ok(commands.has("emote"));

const clientExports = new Map();
const clientHandlers = new Map();
const webHandlers = new Map();
const clientEmits = [];
const shortcuts = [];
global.Exports = { register: (name, value) => clientExports.set(name, value) };
global.Events = {
    on: (name, handler) => clientHandlers.set(name, handler),
    emitServer: (name, payload) => clientEmits.push({ name, payload }),
};
global.Imports = { get: (name) => {
    if (name === "hmp-lib") return { input: {
        controls: { acquire: () => ({ release: () => true }) },
        shortcuts: { register: (definition) => { shortcuts.push(definition); return () => true; }, isDown: () => false },
        cleanup: () => 0,
    } };
    throw new Error(`Unexpected client import ${name}`);
} };
global.LocalPlayer = {
    stopEmote: () => true, playClip: () => true, playAbility: () => true,
    stopPlayerInput: () => true, restorePlayerInput: () => true,
    emotePreview: () => ({ ok: true, visible: false, ready: true, placeable: false, committed: false, anchored: false, status: "" }),
};
global.Web = {
    createView: () => 2, on: (_view, name, handler) => webHandlers.set(name, handler), emit() {}, showView() {}, focusView() {}, hideView() {}, destroyView() {},
};
global.Game = { notify() {} };
require(path.resolve(__dirname, "..", "dist", "client.js"));
assert.ok(clientHandlers.has("hmp-emotes:open"));
assert.ok(clientHandlers.has("hmp-emotes:play"));
clientHandlers.get("hmp-emotes:open")();
assert.ok(webHandlers.has("allowToggle"));
assert.strictEqual(shortcuts.length, 5);
assert.deepStrictEqual(clientEmits.map((entry) => entry.name), ["hmp-emotes:ready"]);
clientHandlers.get("resourceStop")("hmp-emotes");
console.log("hmp-emotes bundle contract passed");
