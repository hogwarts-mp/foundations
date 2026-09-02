const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const exportsSeen = new Map();
const serverHandlers = new Map();
const clientHandlers = new Map();
const webHandlers = new Map();
const emittedToServer = [];
const emittedToWeb = [];
const logger = { info() {}, error() {}, warn() {}, debug() {} };
const core = {
    sessions: { get: () => null },
    characters: { list: async () => [], active: () => null, limit: () => 4 },
    metadata: {},
};

global.Exports = { register: (name, value) => exportsSeen.set(name, value) };
global.Imports = {
    get(name) {
        if (name === "hmp-core") return core;
        if (name === "hmp-lib") return {
            logger: { create: () => logger },
            config: { load: (_path, options) => ({ ...options.defaults }), env: { boolean: (value) => value === "true" } },
            rateLimit: { create: () => ({ allow: () => true }) },
            command: { createRouter: () => ({ register() {}, handle() {} }) },
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

require(path.resolve(__dirname, "..", "dist", "server.js"));
assert.deepStrictEqual([...exportsSeen.keys()], ["ui"]);
assert.strictEqual(typeof exportsSeen.get("ui").open, "function");
assert.ok(serverHandlers.has("worldReady"));
assert.ok(serverHandlers.has("playerAppearanceChanged"));
assert.ok(serverHandlers.has("loadingFinished"));
assert.ok(serverHandlers.has("client:hmp-characters:select"));

global.Events = {
    on: (name, handler) => clientHandlers.set(name, handler),
    emitServer: (name, payload) => emittedToServer.push({ name, payload }),
};
global.Web = {
    createView: () => 1,
    on: (_view, name, handler) => webHandlers.set(name, handler),
    emit(_view, name, payload) { emittedToWeb.push({ name, payload }); return true; },
    showView() {},
    hideView() {},
    focusView() {},
};
global.Game = { lockControls() {}, notify() {} };
global.Creator = { open() {}, isOpen: () => true };
global.Portrait = {
    capture: () => true,
    result: () => "OK",
    busy: () => false,
    lastImage: () => "data:image/png;base64,dGVzdA==",
};

require(path.resolve(__dirname, "..", "dist", "client.js"));
assert.ok(clientHandlers.has("hmp-characters:open"));
assert.ok(clientHandlers.has("hmp-characters:look"));
assert.ok(clientHandlers.has("creatorConfirmed"));
assert.ok(webHandlers.has("select"));
assert.ok(fs.existsSync(path.resolve(__dirname, "..", "dist", "index.html")));
assert.match(fs.readFileSync(path.resolve(__dirname, "..", "dist", "index.html"), "utf8"), /hmp-characters:portrait/);
assert.ok(fs.existsSync(path.resolve(__dirname, "..", "dist", "fonts", "Cinzel-Variable.ttf")));
assert.ok(fs.existsSync(path.resolve(__dirname, "..", "dist", "fonts", "Spectral-Regular.ttf")));

webHandlers.get("ready")();
clientHandlers.get("hmp-characters:open")({
    mode: "wardrobe",
    title: "Characters",
    subtitle: "Choose",
    characters: [{ id: 4, slot: 1, name: "Natsai Onai" }],
    activeCharacterId: null,
    lastCharacterId: 4,
    limit: 4,
    full: false,
    allowDelete: true,
    canClose: true,
});
clientHandlers.get("hmp-characters:look")({ characterId: 4, appearance: "saved-look", transmog: "" });
setTimeout(() => {
    assert.ok(emittedToWeb.some((event) => event.name === "hmp-characters:portrait" && event.payload.characterId === 4 && event.payload.src.startsWith("data:image/png")));
    console.log("hmp-characters bundle contract passed");
}, 100);
