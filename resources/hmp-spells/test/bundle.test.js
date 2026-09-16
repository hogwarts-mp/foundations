const assert = require("node:assert");
const path = require("node:path");

const manifest = require(path.resolve(__dirname, "..", "package.json"));
assert.deepStrictEqual(manifest.mafiahub.clientScripts, ["dist/client.js"]);
assert.ok(!manifest.mafiahub.files.some((file) => file.endsWith(".html")));

const serverExports = new Map();
const serverHandlers = new Map();
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const serverReplies = [];
const metadata = new Map();
let activeCharacter = null;
const player = { id: 1, nickname: "Smoke", emit(name, payload) { serverReplies.push({ name, payload }); }, sendChat() {} };
const core = {
    sessions: { isReady: () => true },
    characters: { active: () => activeCharacter },
    groups: { effective: async () => [], has: async () => true },
    metadata: {
        getCharacter: async (id, key) => metadata.get(`${id}:${key}`),
        setCharacter: async (id, key, value) => { metadata.set(`${id}:${key}`, value); return value; },
    },
};
global.Exports = { register: (name, value) => serverExports.set(name, value) };
global.Imports = { get: (name) => {
    if (name === "hmp-lib") return {
        logger: { create: () => logger },
        config: { load: (_path, options) => options.defaults, env: { boolean: (_value, fallback) => fallback } },
        player: { find: () => player },
    };
    if (name === "hmp-core") return core;
    throw new Error(`Unexpected import ${name}`);
} };
global.PlayerManager = { getAll: () => [player] };
global.Events = {
    on: (name, handler) => serverHandlers.set(name, handler),
    onClient: (name, handler) => serverHandlers.set(`client:${name}`, handler),
    emit() {},
};
const serverEventApi = global.Events;
require(path.resolve(__dirname, "..", "dist", "server.js"));
assert.deepStrictEqual([...serverExports.keys()], ["catalog", "policy", "rules", "providers", "grants", "loadouts", "status"]);
assert.ok(serverHandlers.has("client:hmp-spells:ready"));
assert.ok(serverHandlers.has("client:hmp-spells:assignments"));
assert.ok(serverHandlers.has("client:hmp-spells:cast"));
assert.ok(serverHandlers.has("worldReady"));
assert.ok(serverHandlers.has("loadingFinished"));
assert.ok(serverHandlers.has("hmp:groups:changed"));

const clientExports = new Map();
const clientHandlers = new Map();
const clientEmits = [];
global.Exports = { register: (name, value) => clientExports.set(name, value) };
global.Imports = { get: (name) => {
    if (name === "hmp-lib") return {
        logger: { create: () => logger },
        get input() { throw new Error("spell persistence must not install custom key bindings"); },
    };
    throw new Error(`Unexpected client import ${name}`);
} };
global.Events = {
    on: (name, handler) => clientHandlers.set(name, handler),
    emitServer: (name, payload) => clientEmits.push({ name, payload }),
};
global.Spells = {
    setPolicy() {}, currentLoadout: () => 0,
    loadout: (index = 0) => ({
        index, current: 0, source: "quick-actions",
        slots: index === 0 ? ["Bombarda", null, null, null] : [null, null, null, null],
    }), setLoadoutSlot: () => true,
    cast: (slot) => ({ accepted: true, slot, spellName: "Lumos", reason: null }),
    castRecord: (path) => ({ accepted: true, slot: -1, spellName: path, reason: null }),
};
global.Game = { notify() {} };
require(path.resolve(__dirname, "..", "dist", "client.js"));
assert.deepStrictEqual([...clientExports.keys()], ["clientStatus", "loadout", "setLoadoutSlot", "cast", "importNativeAssignments"]);
assert.ok(clientHandlers.has("hmp-spells:policy"));
assert.ok(clientHandlers.has("hmp-spells:assignments-saved"));
assert.ok(clientHandlers.has("spellAssignment"));
assert.ok(clientHandlers.has("spellCast"));
assert.deepStrictEqual(clientEmits.map((event) => event.name), ["hmp-spells:ready"]);
clientHandlers.get("hmp-spells:policy")({
    unlockSpells: ["Spell_Lumos"], bonusLoadouts: null, characterId: 1,
    assignments: [[null, null, null, null], [null, null, null, null], [null, null, null, null], [null, null, null, null]],
});
clientHandlers.get("spellAssignment")({ source: "native-menu" });
assert.strictEqual(clientEmits.at(-1).name, "hmp-spells:assignments");
assert.strictEqual(JSON.parse(clientEmits.at(-1).payload).assignments[0][0], "native:Bombarda");
clientHandlers.get("spellCast")("/Game/Spells/Lumos/DA_LumosSpellRecord");
clientHandlers.get("resourceStop")("hmp-spells");
async function assignmentSaveContract() {
    global.Events = serverEventApi;
    activeCharacter = { id: 1 };
    const assignments = [
        ["native:Expulso", null, null, null], [null, null, null, null],
        [null, null, null, null], [null, null, null, null],
    ];
    const save = serverHandlers.get("client:hmp-spells:assignments");
    save(player, JSON.stringify({ characterId: 1, assignments }));
    // The network handler is fire-and-forget; let its in-memory persistence chain finish.
    await new Promise(setImmediate);
    assert.deepStrictEqual(metadata.get("1:hmp-spells:loadout-assignments").assignments, assignments);
    assert.deepStrictEqual(serverReplies.map((reply) => reply.name), ["hmp-spells:assignments-saved"],
        "native/API client saves must acknowledge without echoing a policy that rewrites the open menu");
    assert.deepStrictEqual(JSON.parse(serverReplies[0].payload), { characterId: 1, assignments });
    save(player, JSON.stringify({ characterId: 1, assignments }));
    await new Promise(setImmediate);
    assert.deepStrictEqual(serverReplies.map((reply) => reply.name), ["hmp-spells:assignments-saved", "hmp-spells:assignments-saved"]);
    save(player, JSON.stringify({ characterId: 2, assignments }));
    await new Promise(setImmediate);
    assert.strictEqual(serverReplies.length, 2, "stale-character submissions remain rejected");
    assert.strictEqual(metadata.has("2:hmp-spells:loadout-assignments"), false);
    await serverExports.get("loadouts").setSlot(player, 0, 1, "native:Accio");
    assert.strictEqual(serverReplies.at(-1).name, "hmp-spells:policy", "server API mutations still update the client");
    assert.strictEqual(JSON.parse(serverReplies.at(-1).payload).bonusLoadouts, 0);
    await serverExports.get("loadouts").set(player, 3);
    assert.strictEqual(JSON.parse(serverReplies.at(-1).payload).bonusLoadouts, 3);
    activeCharacter = { id: 2 };
    await serverExports.get("policy").sync(player);
    assert.strictEqual(JSON.parse(serverReplies.at(-1).payload).bonusLoadouts, 0);
    activeCharacter = { id: 1 };
    await serverExports.get("policy").sync(player);
    assert.strictEqual(JSON.parse(serverReplies.at(-1).payload).bonusLoadouts, 3);
}

assignmentSaveContract().then(() => console.log("hmp-spells bundle contract passed")).catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
