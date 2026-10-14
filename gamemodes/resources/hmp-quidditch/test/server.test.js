// Runs the server script against fakes: what a session puts in the world, who may manage it, and the
// live tuning dialog. The game itself is not involved; that is the in-game QA suite's job.
const assert = require("node:assert");
const path = require("node:path");

const CONFIG = require("../quidditch.config.js");
const RING = "/Game/Gameplay/BroomRaces/Blueprints/BP_RaceRing.BP_RaceRing_C";
const SNITCH = "/Game/Levels/WorldEvents/Blueprints/LooseSnitch/BP_Loose_Snitch.BP_Loose_Snitch_C";

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)); };

// ---------------------------------------------------------------- world objects
const objects = new Map();
let nextId = 100;
global.WorldObject = {
    create(key, model, opts) {
        const state = new Map();
        const object = {
            id: nextId++, key, model, opts, ownerId: 0,
            position: { x: opts.x, y: opts.y, z: opts.z },
            state: { set: (k, v) => { state.set(k, v); return true; }, get: (k) => state.get(k) },
            stateMap: state,
            attachTo: () => true, detach: () => true, setVelocity: () => true, setVirtualWorld() {},
        };
        objects.set(key, object);
        return object;
    },
    destroy: (key) => objects.delete(key),
};
global.Vector3 = class { constructor(x, y, z) { Object.assign(this, { x, y, z }); } };
global.World = { state: { set() {}, remove() {} } };

// ---------------------------------------------------------------- players
const makePlayer = (id, nickname) => ({
    id, nickname, house: "", chats: [], events: [], position: { x: 0, y: 0, z: 0 },
    emit(name, payload) { this.events.push({ name, payload }); }, sendChat(text) { this.chats.push(text); }, teleport: () => 1,
});
const emitted = (player, name) => player.events.filter((e) => e.name === name).map((e) => JSON.parse(e.payload));
const admin = makePlayer(1, "Admin");
const guest = makePlayer(2, "Guest");
let online = [admin, guest];
global.PlayerManager = { getAll: () => online, getById: (id) => online.find((p) => p.id === id) || null };

// ---------------------------------------------------------------- foundations
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const markers = new Map();
const uiAnswers = [];
let inputCall = null;
let contextCalls = 0;
const services = {
    "hmp-lib": { logger: { create: () => logger }, input: { shortcuts: { register: () => () => true }, cleanup() {} } },
    "hmp-core": {
        characters: { active: () => null },
        metadata: { getCharacter: async () => ({}), setCharacter: async () => ({}) },
        groups: { has: async (player, key, grade) => key === "admin" && grade === 1 && (player.id ?? player) === admin.id },
    },
    "hmp-activities": {
        definitions: { register: () => async () => 0 },
        sessions: {
            create: async () => ({ id: "activity-1", participants: [] }), get: () => null,
            join: async () => ({}), start: async () => ({}), complete: async () => ({}), cancel: async () => ({}),
        },
        status: () => ({ state: "ready" }),
    },
    "hmp-ui": {
        notify() {}, close() {},
        context: async () => { contextCalls++; return uiAnswers.shift() ?? null; },
        input: (player, dialog, options) => new Promise((resolve) => { inputCall = { player, dialog, options, resolve }; }),
    },
    "hmp-houses": { membership: { sync: async () => null }, status: () => ({ state: "ready" }) },
    "hmp-inventory": { native: { list: () => [], give: async () => 1 } },
    "hmp-interact": { register: () => () => true },
    "hmp-audio": { sounds: { playForAll: () => null, playAt: () => null, playForPlayer: () => null, stop: () => true, release: () => 0 } },
    "hmp-blips": { markers: { clear: () => 0, upsert: async (marker) => { markers.set(marker.id, marker); return marker; }, remove: (id) => markers.delete(id) } },
    // A match never changes the server-wide world policy; any call here throws.
    "hmp-world": { status: () => ({ state: "ready" }) },
};

const exportsMap = new Map();
const handlers = new Map();
global.Imports = { get: (name) => services[name] };
global.Exports = { register: (name, value) => exportsMap.set(name, value) };
global.Events = {
    on: (name, handler) => handlers.set(name, handler),
    onClient: (name, handler) => handlers.set(`client:${name}`, handler),
    listenerCount: () => 0,
    emit() {},
};
const intervals = [];
const realSetInterval = global.setInterval;
const realSetTimeout = global.setTimeout;
global.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return { unref() {} }; };
global.setTimeout = (fn, ms) => (ms > 1000 ? { unref() {} } : realSetTimeout(fn, ms));

require(path.resolve(__dirname, "..", "server", "main.js"));
const tickMs = Math.max(20, Math.floor(1000 / (CONFIG.scoring.tickHz || 20)));
const tick = intervals.find((entry) => entry.ms === tickMs).fn;
const start = exportsMap.get("start");
const stop = exportsMap.get("stop");
const chat = (player, ...args) => handlers.get("chatCommand")(player, `/quidditch ${args.join(" ")}`, "quidditch", args);

(async () => {
    // Practice: the quaffle is a physics object, the hoops are race-ring Blueprints, nothing else.
    start(admin, "practice", true);
    await flush();
    const quaffle = objects.get("quidditch:quaffle");
    assert.ok(quaffle, "practice spawned no quaffle");
    assert.strictEqual(quaffle.model, CONFIG.ball.mesh);
    assert.strictEqual(quaffle.opts.physics, true);
    const rings = [...objects.values()].filter((o) => o.model === RING);
    assert.strictEqual(rings.length, CONFIG.pitch.hoopGeometry.heights.length * 2);
    assert.ok(![...objects.values()].some((o) => o.model === SNITCH), "practice released a snitch");

    stop("test");
    await flush();
    assert.strictEqual(objects.size, 0, `stopping left ${[...objects.keys()].join(", ")}`);

    // Snitch hunt: one simulated snitch Blueprint and the configured bludgers.
    start(admin, "snitchHunt", true);
    await flush();
    const snitch = [...objects.values()].find((o) => o.model === SNITCH);
    assert.ok(snitch, "the snitch hunt released no snitch");
    assert.strictEqual(snitch.opts.simulated, true);
    assert.strictEqual([...objects.values()].filter((o) => o.model === CONFIG.bludgers.mesh).length, CONFIG.bludgers.count);

    // The marker follows the snitch its simulator flies, not the server's steering point.
    handlers.get("client:quidditch:snitchCmd")(admin, { blip: true });
    await flush();
    snitch.position = { x: 1234, y: 5678, z: 910 };
    for (let i = 0; i < 10; i++) tick();
    await flush();
    assert.deepStrictEqual(markers.get("snitch")?.position, { x: 1234, y: 5678, z: 910 });
    assert.strictEqual(typeof snitch.stateMap.get("snitch.x"), "number", "the snitch was never steered");

    // Match control: staff only while staff is online, anyone once nobody qualifies.
    handlers.get("client:quidditch:manageStart")(guest, { stop: true });
    await flush();
    assert.ok([...objects.values()].some((o) => o.model === SNITCH), "a guest stopped the match while an admin was online");
    assert.match(guest.chats.at(-1), /admin group/);
    online = [guest];
    handlers.get("client:quidditch:manageStart")(guest, { stop: true });
    await flush();
    assert.strictEqual(objects.size, 0, "with no admin online the guest could not stop the match");
    online = [admin, guest];

    // Tuning: a slider applies live and Revert puts it back.
    const before = CONFIG.snitch.catchRadius;
    uiAnswers.push("tune", "snitch");
    await chat(admin, "manager");
    await flush();
    assert.ok(inputCall, "the tuning dialog never opened");
    const field = inputCall.dialog.fields.find((f) => f.name === "catchradius");
    assert.ok(field && field.type === "range", "the snitch tab has no catch-radius slider");
    assert.strictEqual(field.default, before);
    inputCall.options.onChange("catchradius", 1200);
    assert.strictEqual(CONFIG.snitch.catchRadius, 1200, "the slider did not apply live");
    inputCall.resolve(null);
    await flush();
    assert.strictEqual(CONFIG.snitch.catchRadius, before, "Revert did not restore the slider");

    // A call shows each eligible player a card and nothing that takes their screen.
    const contextsBefore = contextCalls;
    exportsMap.get("call")(admin, "match", "gryffindor", "slytherin", true);
    await flush();
    assert.strictEqual(contextCalls, contextsBefore, "calling a match opened a dialog on someone's screen");
    const card = emitted(guest, "quidditch:lobbyCard").at(-1);
    assert.strictEqual(card.title, "Open match");
    assert.strictEqual(card.key, "J");
    assert.strictEqual(card.referee, false);
    assert.ok(card.remainingMs > 0 && card.teams.length === 2);
    assert.strictEqual(emitted(admin, "quidditch:lobbyCard").at(-1).referee, true);

    // The card's key opens the picker, and a pick reaches every card.
    uiAnswers.push("join:gryffindor:seeker");
    handlers.get("client:quidditch:lobbyOpen")(guest);
    await flush();
    assert.strictEqual(contextCalls, contextsBefore + 1, "the key did not open the picker");
    assert.strictEqual(emitted(guest, "quidditch:lobbyCard").at(-1).pick, "Gryffindor Seeker");
    assert.strictEqual(emitted(admin, "quidditch:lobbyCard").at(-1).teams[0].filled, 1, "the referee's card missed the pick");

    // Calling it off takes every card down.
    await chat(admin, "cancel");
    await flush();
    assert.deepStrictEqual(emitted(guest, "quidditch:lobbyCard").at(-1), { closed: true });
    assert.strictEqual(contextCalls, contextsBefore + 1, "calling off opened a dialog");

    handlers.get("resourceStop")("hmp-quidditch");
    global.setInterval = realSetInterval;
    global.setTimeout = realSetTimeout;
    console.log("hmp-quidditch server behaviour passed");
})().catch((error) => { console.error(error); process.exit(1); });
