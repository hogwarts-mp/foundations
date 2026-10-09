const assert = require("node:assert");
const path = require("node:path");

const serverExports = new Map();
const serverHandlers = new Map();
const commands = new Map();
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const player = { id: 1, nickname: "Smoke", sendChat() {} };
const placed = [];
const views = [];
const suppressed = [];
const database = {
    ready: async () => true, migrate: async () => ({}), update: async () => 1,
    query: async () => [{ lootable_key: "courtyard-chest", character_id: 0, account_id: null, taken_at: Date.now(), respawn_at: Date.now() + 60000 }],
};
const core = { accounts: { getByPlayer: () => ({ id: 1 }) }, characters: { active: () => ({ id: 7 }) }, groups: { has: async () => true } };
const lootables = [
    { key: "courtyard-chest", kind: "chest", position: { x: 1, y: 2, z: 3 }, items: [{ itemId: "AshwinderEggs", count: 2 }], scope: "shared", respawnSeconds: 600 },
    { key: "courtyard-eggs", kind: "foragable", position: { x: 4, y: 5, z: 6 }, items: [{ itemId: "AshwinderEggs", count: 1 }], respawnSeconds: 60 },
];
global.Exports = { register: (name, value) => serverExports.set(name, value) };
global.Imports = { get: (name) => {
    if (name === "hmp-mysql") return database;
    if (name === "hmp-core") return core;
    if (name === "hmp-lib") return {
        logger: { create: () => logger },
        config: { load: (_path, options) => ({ ...options.defaults, suppressGameLoot: { chests: true, moonstones: true, foragables: true }, lootables }), env: { boolean: (_value, fallback) => fallback } },
        command: { createRouter: () => ({
            register: (name, _options, handler) => commands.set(name, handler),
            handle: async (p, message, command, args) => { const h = commands.get(command); if (!h) return false; await h({ player: p, message, command, invokedAs: command, args, usage: "usage", reply() { return true; } }); return true; },
        }) },
    };
    throw new Error(`Unexpected import ${name}`);
} };
global.PlayerManager = { getAll: () => [player] };
global.Events = { on: (name, handler) => serverHandlers.set(name, handler) };
global.Lootables = {
    place: (kind, x, y, z, yaw, options) => { placed.push({ kind, options }); return placed.length; },
    setItems: () => true,
    setView: (id, p, view) => { views.push({ id, player: p.id, view }); return true; },
    remove: () => true,
};
global.World = { lootSuppressed: { chests: false, moonstones: false, foragables: false }, suppressLoot: (families) => { suppressed.push(families); return true; } };

require(path.resolve(__dirname, "..", "dist", "server.js"));
assert.deepStrictEqual([...serverExports.keys()], ["lootables", "status"]);
for (const name of ["lootableTaken", "playerConnect", "hmp:session:ready", "hmp:character:loaded", "hmp:character:unloaded", "resourceStart", "resourceStop", "chatCommand"]) {
    assert.ok(serverHandlers.has(name), `no handler for ${name}`);
}
assert.ok(commands.has("loot"));

(async () => {
    serverHandlers.get("resourceStart")("hmp-loot");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const status = serverExports.get("status")();
    assert.strictEqual(status.state, "ready", status.lastError);
    assert.strictEqual(status.lootables, 2);
    assert.deepStrictEqual(suppressed, [{ chests: true, moonstones: true, foragables: true }]);
    assert.deepStrictEqual(placed.map((p) => [p.kind, p.options.mode, p.options.items.length]), [["chest", "shared", 0], ["foragable", "perPlayer", 1]]);
    assert.deepStrictEqual(views.at(-1), { id: 2, player: 1, view: null });
    views.length = 0;
    serverHandlers.get("hmp:session:ready")({ player, playerId: 1 });
    assert.deepStrictEqual(views, [{ id: 2, player: 1, view: null }], "hmp:session:ready carries the session itself");
    serverHandlers.get("hmp:character:loaded")({ session: { player }, character: { id: 7 } });
    assert.strictEqual(views.length, 2, "hmp:character:loaded carries { session, character }");
    serverHandlers.get("lootableTaken")(player, 2, [{ itemId: "AshwinderEggs", count: 1 }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(serverExports.get("lootables").record("courtyard-eggs", 7));
    await serverHandlers.get("chatCommand")(player, "/loot list", "loot", ["list"]);
    serverHandlers.get("resourceStop")("hmp-loot");
    assert.deepStrictEqual(suppressed.at(-1), { chests: false, moonstones: false, foragables: false });
    console.log("hmp-loot bundle contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
