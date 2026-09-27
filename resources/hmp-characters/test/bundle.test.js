const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const exportsSeen = new Map();
const serverHandlers = new Map();
const clientHandlers = new Map();
const webHandlers = new Map();
const emittedToServer = [];
const emittedToWeb = [];
const importedLooks = [];
const logger = { info() {}, error() {}, warn() {}, debug() {} };
const core = {
    sessions: { get: () => null },
    characters: { list: async () => [], active: () => null, limit: () => 4 },
    metadata: {},
};

global.Exports = { register: (name, value) => exportsSeen.set(name, value) };
global.Character = { isAllowed: () => true };
global.Imports = {
    get(name) {
        if (name === "hmp-core") return core;
        if (name === "hmp-inventory") return { native: { save: async () => true } };
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
assert.deepStrictEqual([...exportsSeen.keys()], ["ui", "appearance"]);
assert.strictEqual(typeof exportsSeen.get("ui").open, "function");
assert.strictEqual(exportsSeen.get("appearance").listTransmogs().length, 151);
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
global.Creator = {
    open() {},
    close() {},
    isOpen: () => true,
    importLook(look) { importedLooks.push(look); return true; },
};
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
assert.ok(webHandlers.has("import"));
assert.ok(webHandlers.has("export"));
assert.ok(fs.existsSync(path.resolve(__dirname, "..", "dist", "index.html")));
const page = fs.readFileSync(path.resolve(__dirname, "..", "dist", "index.html"), "utf8");
assert.match(page, /hmp-characters:portrait/);
assert.match(page, /hmp-characters:export/);
assert.match(page, /id="copy-export"/);
assert.match(page, /id="import-modal"/);
assert.match(page, /id="submit-import"/);
assert.doesNotMatch(page, /id="download-export"/);
const inlineScript = page.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(inlineScript);
assert.doesNotThrow(() => new Function(inlineScript[1]));
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
clientHandlers.get("hmp-characters:look")({
    characterId: 4,
    look: { format: "hogwartsmp-look", version: 2, gender: "female", presets: { hairStyle: "saved-look" }, gear: [] },
    transmog: "",
});
webHandlers.get("export")({ characterId: 4 });
const exported = emittedToWeb.find((event) => event.name === "hmp-characters:export");
assert.strictEqual(exported?.payload.name, "Natsai Onai");
assert.strictEqual(JSON.parse(exported?.payload.json).presets.hairStyle, "saved-look");
setTimeout(() => {
    assert.ok(emittedToWeb.some((event) => event.name === "hmp-characters:portrait" && event.payload.characterId === 4 && event.payload.src.startsWith("data:image/png")));
    const imported = { format: "hogwartsmp-look", version: 2, gender: "female", presets: { hairStyle: "shared-look" }, gear: [] };
    webHandlers.get("import")({ look: imported });
    assert.ok(emittedToServer.some((event) => event.name === "hmp-characters:create"));
    clientHandlers.get("hmp-characters:create")();
    assert.deepStrictEqual(importedLooks, [imported]);
    console.log("hmp-characters bundle contract passed");
}, 100);
