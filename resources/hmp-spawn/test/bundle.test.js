const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const exportsSeen = new Map();
const serverHandlers = new Map();
const clientHandlers = new Map();
const webHandlers = new Map();
const emittedToServer = [];
const logger = { info() {}, error() {}, warn() {}, debug() {} };
const core = {
    sessions: { get: () => null },
    characters: { active: () => null },
    metadata: { getCharacter: async () => null, setCharacter: async () => null },
};

global.Exports = { register: (name, value) => exportsSeen.set(name, value) };
global.Imports = {
    get(name) {
        if (name === "hmp-core") return core;
        if (name === "hmp-lib") return {
            logger: { create: () => logger },
            config: { load: (_path, options) => ({ ...options.defaults }), env: { boolean: (value) => value === "true" } },
            rateLimit: { create: () => ({ allow: () => true }) },
            input: { controls: { acquire: () => ({ release: () => true }) } },
        };
        throw new Error(`Unexpected import ${name}`);
    },
};
global.Events = {
    on: (name, handler) => serverHandlers.set(name, handler),
    onClient: (name, handler) => serverHandlers.set(`client:${name}`, handler),
    emit: async () => {},
};
global.PlayerManager = { getAll: () => [] };

require(path.resolve(__dirname, "..", "dist", "server.js"));
assert.deepStrictEqual([...exportsSeen.keys()], ["locations", "ui", "spawn", "status"]);
assert.ok(serverHandlers.has("hmp:character:selected"));
assert.ok(serverHandlers.has("playerTeleportComplete"));
assert.ok(serverHandlers.has("loadingFinished"));
assert.ok(serverHandlers.has("client:hmp-spawn:select"));

global.Events = {
    on: (name, handler) => clientHandlers.set(name, handler),
    emitServer: (name, payload) => emittedToServer.push({ name, payload }),
};
global.Web = {
    createView: () => 1,
    on: (_view, name, handler) => webHandlers.set(name, handler),
    emit() {},
    showView() {},
    hideView() {},
    focusView() {},
};
global.Game = { lockControls() {}, notify() {} };
global.Camera = { fade: () => true, stopFade: () => true };

require(path.resolve(__dirname, "..", "dist", "client.js"));
assert.ok(clientHandlers.has("hmp-spawn:open"));
assert.ok(clientHandlers.has("hmp-spawn:complete"));
assert.ok(webHandlers.has("select"));
assert.ok(fs.existsSync(path.resolve(__dirname, "..", "dist", "index.html")));
console.log("hmp-spawn bundle contract passed");
