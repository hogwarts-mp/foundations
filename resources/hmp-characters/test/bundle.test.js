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
const viewUrls = [];
let creatorBegun = 0;
let creatorCommitted = 0;
let creatorCancelled = 0;
let nextView = 0;
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
    createView(url) { viewUrls.push(url); return ++nextView; },
    on: (_view, name, handler) => webHandlers.set(name, handler),
    emit(_view, name, payload) { emittedToWeb.push({ name, payload }); return true; },
    showView() {},
    hideView() {},
    focusView() {},
};
global.Game = { lockControls() {}, notify() {} };
const creatorSchema = {
    version: 1,
    gender: 1,
    categories: {
        preset: { options: ["preset-a"], count: 1 },
        hairStyle: { options: ["saved-look", "shared-look"], count: 2 },
        glasses: { options: ["GA_Face_001"], count: 1 },
    },
};
const creatorState = {
    gender: 1,
    selections: { preset: "preset-a", hairStyle: "shared-look" },
    faceGear: "",
    voice: { tone: 0, pitch: 0 },
    name: { first: "Natsai", last: "Onai" },
};
global.Creator = {
    getCapabilities: () => ({ version: 3, session: true, sessionHolder: "none", schema: true, state: true, patch: true, preview: true, look: true }),
    begin() { creatorBegun++; return true; },
    commit() { creatorCommitted++; return true; },
    cancel() { creatorCancelled++; return true; },
    getSchema: () => creatorSchema,
    getState: () => creatorState,
    applyPatch: () => 1,
    setVoice: () => true,
    setName: () => true,
    exportLook: () => ({ format: "hogwartsmp-look", version: 2, gender: "female", presets: { hairStyle: "shared-look" }, gear: [] }),
    importLook(look) { importedLooks.push(look); return true; },
};
global.CreatorPreview = { setCamera() {}, restoreCamera() {}, rotate() {}, freeze() {}, playIdle: () => true };
global.Portrait = {
    capture: () => true,
    result: () => "OK",
    busy: () => false,
    lastImage: () => "data:image/png;base64,dGVzdA==",
};

require(path.resolve(__dirname, "..", "dist", "client.js"));
assert.ok(clientHandlers.has("hmp-characters:open"));
assert.ok(clientHandlers.has("hmp-characters:look"));
assert.ok(clientHandlers.has("creatorChanged"));
assert.ok(webHandlers.has("select"));
assert.ok(webHandlers.has("import"));
assert.ok(webHandlers.has("export"));
assert.ok(webHandlers.has("creator:ready"));
assert.ok(webHandlers.has("creator:confirm"));
assert.ok(webHandlers.has("creator:export"));
assert.deepStrictEqual(viewUrls, ["fw://resources/hmp-characters/dist/index.html", "fw://resources/hmp-characters/dist/creator.html"]);
assert.ok(fs.existsSync(path.resolve(__dirname, "..", "dist", "index.html")));
assert.ok(fs.existsSync(path.resolve(__dirname, "..", "dist", "creator.html")));
assert.ok(fs.existsSync(path.resolve(__dirname, "..", "dist", "creator.js")));
const page = fs.readFileSync(path.resolve(__dirname, "..", "dist", "index.html"), "utf8");
assert.match(page, /hmp-characters:portrait/);
assert.match(page, /hmp-characters:export/);
assert.match(page, /id="copy-export"/);
assert.match(page, /id="import-modal"/);
assert.match(page, /id="submit-import"/);
assert.doesNotMatch(page, /id="download-export"/);
const creatorPage = fs.readFileSync(path.resolve(__dirname, "..", "dist", "creator.html"), "utf8");
const creatorBundle = fs.readFileSync(path.resolve(__dirname, "..", "dist", "creator.js"), "utf8");
assert.match(creatorPage, /creator\.js/);
assert.match(creatorBundle, /COPY LOOK JSON/);
assert.match(creatorBundle, /IMPORT JSON/);
const inlineScript = page.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(inlineScript);
assert.doesNotThrow(() => new Function(inlineScript[1]));
assert.ok(fs.existsSync(path.resolve(__dirname, "..", "dist", "fonts", "Cinzel-Variable.ttf")));
assert.ok(fs.existsSync(path.resolve(__dirname, "..", "dist", "fonts", "Spectral-Regular.ttf")));

webHandlers.get("ready")();
webHandlers.get("creator:ready")();
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
    assert.strictEqual(creatorBegun, 1);
    clientHandlers.get("creatorChanged")({});
    assert.deepStrictEqual(importedLooks, [imported]);
    clientHandlers.get("creatorChanged")({});
    assert.ok(emittedToWeb.some((event) => event.name === "hmp-creator:open" && event.payload.schema === creatorSchema));
    webHandlers.get("creator:export")();
    assert.ok(emittedToWeb.some((event) => event.name === "hmp-creator:export" && JSON.parse(event.payload.json).presets.hairStyle === "shared-look"));
    webHandlers.get("creator:confirm")({ first: "Natsai", last: "Onai", dorm: "witch" });
    assert.strictEqual(creatorCommitted, 1);
    assert.strictEqual(creatorCancelled, 0);
    assert.ok(emittedToServer.some((event) => event.name === "hmp-characters:confirmed" && JSON.parse(event.payload).first === "Natsai"));
    console.log("hmp-characters bundle contract passed");
}, 100);
