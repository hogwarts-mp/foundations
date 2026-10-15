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
const intervals = [];
global.setInterval = (handler, milliseconds) => {
    const timer = { handler, milliseconds, unrefed: false, unref() { timer.unrefed = true; return timer; } };
    intervals.push(timer);
    return timer;
};
global.clearInterval = () => {};

require(path.resolve(__dirname, "..", "dist", "server.js"));
assert.deepStrictEqual([...exportsSeen.keys()], ["locations", "ui", "spawn", "status"]);
// An unref'd autosave would never fire in the resource's own event loop.
assert.deepStrictEqual(intervals.map((timer) => [timer.milliseconds, timer.unrefed]), [[60000, false]]);

// A selection whose teleport the host rejects, by throwing or with no request id, reaches the client as one failure.
async function rejectedSelectionReportsOnce() {
    const refusals = [
        ["Player is not in the world", () => { throw new Error("Player is not in the world"); }],
        ["The streamed teleport was not accepted", () => 0],
    ];
    for (const [message, teleport] of refusals) {
        const sent = [];
        const player = {
            id: 4,
            emit: (name, payload) => sent.push({ name, payload: JSON.parse(payload) }),
            location: () => ({ areaId: "Overland", regionId: "Hogwarts", destinationId: null, x: 0, y: 0, z: 0, yaw: 0, revision: 1 }),
            teleport,
        };
        const character = { id: 9, name: "Poppy" };
        core.sessions.get = (candidate) => (candidate === player || candidate === 4 ? { player, character } : null);
        core.characters.active = () => character;
        serverHandlers.get("client:hmp-spawn:select")(player, { key: "hogwarts" });
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.deepStrictEqual(sent.map((event) => event.name), ["hmp-spawn:transition", "hmp-spawn:failed"]);
        assert.strictEqual(sent[1].payload.message, message);
    }
}
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
rejectedSelectionReportsOnce().then(() => console.log("hmp-spawn bundle contract passed"), (error) => {
    console.error(error);
    process.exitCode = 1;
});
