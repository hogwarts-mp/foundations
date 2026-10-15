const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const exportsSeen = new Map();
const serverHandlers = new Map();
const clientHandlers = new Map();
const webHandlers = new Map();
const emittedToServer = [];
let createdViewUrl = "";
let destroyedViews = 0;
const logger = { info() {}, error() {}, warn() {}, debug() {} };
const database = {
    ready: async () => true,
    migrate: async () => ({ applied: [1] }),
    transaction: async (work) => work(database),
    query: async () => [],
    single: async () => null,
    scalar: async () => null,
    insert: async () => 1,
    update: async () => 1,
};
const core = { characters: { active: () => null } };

global.Exports = { register: (name, value) => exportsSeen.set(name, value) };
global.Imports = {
    get(name) {
        if (name === "hmp-mysql") return database;
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
global.InventoryCatalog = {
    info: () => ({ schemaVersion: 1, gameBuild: "test", definitions: 2 }),
    get: () => null,
    has: () => false,
    list: () => [
        { itemId: "WoundCleaning", itemType: "PotionUsable", holder: "HealthPotionStorage", maxStack: 25, kind: "item", inventoryable: true, persistent: true, consumable: true, usableFromInventory: true },
        { itemId: "Knuts", itemType: "SPECIAL", holder: "ResourceInventory", maxStack: 999999, kind: "item", inventoryable: true, persistent: false, consumable: false, usableFromInventory: false },
    ],
    holderPair: () => null,
};

const intervals = [];
const realSetInterval = global.setInterval;
global.setInterval = (...args) => {
    const timer = realSetInterval(...args);
    intervals.push(timer);
    return timer;
};
require(path.resolve(__dirname, "..", "dist", "server.js"));
global.setInterval = realSetInterval;
assert.deepStrictEqual([...exportsSeen.keys()], ["items", "inventory", "containers", "transfers", "native", "ui", "status"]);
assert.ok(serverHandlers.has("hmp:character:loading"));
assert.ok(serverHandlers.has("playerInventoryUpdated"));
assert.ok(serverHandlers.has("playerInventoryChanged"));
// A resource's own loop never runs an unref'd timer, so the autosave has to stay referenced.
assert.strictEqual(intervals.length, 1);
assert.strictEqual(intervals[0].hasRef(), true);
serverHandlers.get("resourceStop")("hmp-inventory");
assert.ok(serverHandlers.has("client:hmp-inventory:use"));
assert.strictEqual(exportsSeen.get("items").get("native:galleons").nativeId, "Knuts");
assert.strictEqual(exportsSeen.get("items").get("native:knuts").name, "native:galleons");
assert.strictEqual(exportsSeen.get("items").fromNative("Knuts").name, "native:galleons");
assert.strictEqual(exportsSeen.get("items").list().filter((item) => item.nativeId === "Knuts").length, 1);

global.Events = {
    on: (name, handler) => clientHandlers.set(name, handler),
    emitServer: (name, payload) => emittedToServer.push({ name, payload }),
};
global.Web = {
    createView: (url) => { createdViewUrl = url; return 1; },
    destroyView: () => { destroyedViews++; return true; },
    on: (_view, name, handler) => webHandlers.set(name, handler),
    emit() {}, showView() {}, hideView() {}, focusView() {},
};
global.Game = { lockControls() {}, notify() {} };

require(path.resolve(__dirname, "..", "dist", "client.js"));
assert.ok(clientHandlers.has("hmp-inventory:open"));
assert.ok(clientHandlers.has("hmp-inventory:configure"));
clientHandlers.get("hmp-inventory:open")(JSON.stringify({ items: [], container: {} }));
assert.strictEqual(createdViewUrl, "fw://resources/hmp-inventory/dist/index.html");
clientHandlers.get("hmp-inventory:configure")(JSON.stringify({
    contract: "hmp.inventory.ui/v1",
    url: "fw://resources/my-inventory-ui/dist/index.html",
}));
assert.strictEqual(createdViewUrl, "fw://resources/my-inventory-ui/dist/index.html");
assert.strictEqual(destroyedViews, 1);
assert.ok(webHandlers.has("use"));
assert.ok(emittedToServer.some((event) => event.name === "hmp-inventory:ready"));
assert.ok(fs.existsSync(path.resolve(__dirname, "..", "dist", "index.html")));
assert.ok(fs.existsSync(path.resolve(__dirname, "..", "dist", "icons", "potion.svg")));
assert.ok(fs.existsSync(path.resolve(__dirname, "..", "dist", "fonts", "Cinzel-Variable.ttf")));
assert.ok(fs.existsSync(path.resolve(__dirname, "..", "dist", "fonts", "Spectral-Regular.ttf")));
console.log("hmp-inventory bundle contract passed");
