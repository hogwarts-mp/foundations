const assert = require("node:assert");
const path = require("node:path");

const tick = () => new Promise((resolve) => setImmediate(resolve));
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const commands = new Map();
const serverHandlers = new Map();
const chat = [];
const emitted = [];
const timers = [];

const makePlayer = (id) => ({
    id, nickname: `Player ${id}`, position: { x: 100, y: 200, z: 300 }, sent: [], messages: [],
    emit(event, payload) { this.sent.push({ event, payload: JSON.parse(payload) }); },
    sendChat(message) { this.messages.push(message); },
});
const host = makePlayer(1);
const guest = makePlayer(2);
const players = [host, guest];

const spawned = [];
const destroyed = [];
const npcs = {
    catalog: {
        list: () => [
            { id: "Goblin_Melee", label: "Goblin" },
            { id: "Spider_Small", label: "Spider" },
            { id: "Troll_Forest", label: "Forest Troll" },
            { id: "Mandrake", label: "Mandrake" },
        ],
    },
    spawn: (input) => { const npc = { id: 1000 + spawned.length, enemyId: input.enemyId }; spawned.push({ ...input, id: npc.id }); return npc; },
    destroy: (id, resource) => { destroyed.push({ id, resource }); return true; },
    clear: () => 0,
};

const definitions = [];
const lifecycle = [];
let session = null;
const activities = {
    definitions: { register: (definition) => { definitions.push(definition); return async () => 1; } },
    sessions: {
        create: async (player, activityId, input) => {
            session = { id: `session-${lifecycle.length}`, activityId, leaderPlayerId: player.id, participants: [{ playerId: player.id }], input };
            lifecycle.push({ type: "create", id: session.id });
            return session;
        },
        join: async (player, id) => { session.participants.push({ playerId: player.id }); lifecycle.push({ type: "join", id }); return session; },
        start: async (id) => { lifecycle.push({ type: "start", id }); return session; },
        complete: async (id, result) => { lifecycle.push({ type: "complete", id, result }); return session; },
        cancel: async (id, context) => { lifecycle.push({ type: "cancel", id, reason: context.reason }); return session; },
        get: () => session,
    },
};

const board = new Map();
const bests = new Map();
const services = {
    "hmp-lib": {
        logger: { create: () => logger },
        config: { load: (_candidates, options) => options.defaults },
        command: { createRouter: () => ({ register: (name, handler) => { commands.set(name, handler); return () => true; }, handle: async () => false }) },
    },
    "hmp-core": {
        characters: { active: (player) => ({ id: player.id * 10, name: `Character ${player.id}` }) },
        metadata: {
            getCharacter: async (id, key) => bests.get(`${id}:${key}`),
            setCharacter: async (id, key, value) => { bests.set(`${id}:${key}`, value); return value; },
        },
    },
    "hmp-activities": activities,
    "hmp-interact": { register: () => { throw new Error("the altar is disabled by default"); } },
    "hmp-worldstate": {
        systems: { register: (name) => { assert.strictEqual(name, "gauntlet-board"); return () => true; } },
        state: { get: (_system, key) => board.get(key) ?? null, set: async (_system, key, value) => { board.set(key, value); return true; } },
    },
    "hmp-npcs": npcs,
};

global.Imports = { get: (name) => services[name] };
global.PlayerManager = { getAll: () => players, getById: (id) => players.find((player) => player.id === id) || null };
global.Chat = { sendToAll: (message) => chat.push(message) };
global.Events = {
    on: (name, handler) => serverHandlers.set(name, handler),
    onClient: (name, handler) => serverHandlers.set(`client:${name}`, handler),
    emit: (name, payload) => emitted.push({ name, payload }),
};
const realSetTimeout = global.setTimeout;
global.setTimeout = (handler) => { timers.push(handler); return { unref() {} }; };

async function runServer() {
    require(path.resolve(__dirname, "..", "dist", "server.js"));
    const gauntlet = commands.get("gauntlet");
    assert.ok(gauntlet, "the /gauntlet command must be registered");
    assert.strictEqual(definitions[0].id, "hmp-gauntlet:survival");
    for (const name of ["npcDied", "playerDied", "playerDowned", "playerDownedEnd", "chatCommand", "resourceStop", "client:hmp-gauntlet:start", "hmp:activities:cancelled"]) {
        assert.ok(serverHandlers.has(name), `missing ${name} handler`);
    }

    await gauntlet({ player: host, args: ["menu"] });
    const menu = host.sent.find((entry) => entry.event === "hmp-gauntlet:configure").payload;
    assert.deepStrictEqual(menu.enemies.map((entry) => entry.id), ["Goblin_Melee", "Spider_Small"], "bosses and hidden enemies stay out of the pool");
    assert.deepStrictEqual(menu.presets, ["easy", "normal", "nightmare"]);

    await gauntlet({ player: host, args: ["start"] });
    await gauntlet({ player: guest, args: ["join"] });
    await gauntlet({ player: host, args: ["begin"] });
    assert.deepStrictEqual(lifecycle.map((entry) => entry.type), ["create", "join", "start"]);

    // Normal wave 1: 4 enemies, scaled by 1.75 for the second fighter, owners alternating.
    assert.strictEqual(spawned.length, 7);
    assert.ok(spawned.every((npc) => npc.resource === "hmp-gauntlet" && npc.disposition === "hostile" && npc.maxHealth === 200));
    assert.deepStrictEqual(spawned.slice(0, 4).map((npc) => npc.ownerId), [1, 2, 1, 2]);
    assert.deepStrictEqual(host.sent.at(-1), { event: "hmp-gauntlet:hud", payload: { active: true, wave: 1, waves: 10, enemies: 7, score: 0 } });

    for (const npc of [...spawned]) serverHandlers.get("npcDied")(npc.id);
    assert.strictEqual(timers.length, 1, "a cleared wave schedules the intermission");
    timers.shift()();
    assert.strictEqual(spawned.length, 7 + 8, "wave 2 spawns up to maxAlive");

    serverHandlers.get("playerDied")(host);
    serverHandlers.get("playerDied")(guest);
    await tick();
    assert.deepStrictEqual(lifecycle.at(-1).result, { won: false, score: 7, wave: 2 });
    assert.deepStrictEqual(destroyed.map((entry) => entry.id).sort(), spawned.map((npc) => npc.id).sort());
    assert.deepStrictEqual(guest.sent.at(-1), { event: "hmp-gauntlet:hud", payload: { active: false } });
    const completion = emitted.find((entry) => entry.name === "hmp-gauntlet:complete").payload;
    assert.strictEqual(completion.ranked, true);
    assert.strictEqual(completion.bucket, "duo");
    assert.deepStrictEqual(completion.participants.map((entry) => entry.character), ["Character 1", "Character 2"]);
    assert.strictEqual(JSON.parse(board.get("normal:duo")).score, 7);
    assert.deepStrictEqual(bests.get("20:hmp-gauntlet:bests"), { "normal:duo": { score: 7, wave: 2 } });

    await gauntlet({ player: guest, args: ["top"] });
    assert.ok(guest.messages.some((line) => line.includes("7 pts (wave 2) by Player 1")));

    // A menu run with a trimmed pool is custom: never ranked, and a stop cancels the activity.
    serverHandlers.get("client:hmp-gauntlet:start")(host, JSON.stringify({ preset: "easy", pool: ["Goblin_Melee"] }));
    await tick();
    await gauntlet({ player: host, args: ["stop"] });
    await tick();
    assert.strictEqual(lifecycle.at(-1).type, "cancel");
    assert.strictEqual(emitted.at(-1).payload.cancelled, true);
    assert.strictEqual(emitted.at(-1).payload.ranked, false);
    assert.strictEqual(board.size, 1);
}

function runClient() {
    const handlers = new Map();
    const views = new Map();
    const toServer = [];
    let released = 0;
    global.Events = { on: (name, handler) => handlers.set(name, handler), emitServer: (name, payload) => toServer.push({ name, payload }) };
    global.Imports = { get: () => ({ input: { controls: { acquire: () => ({ release: () => { released += 1; return true; } }) } } }) };
    global.Game = { notify: (message) => { throw new Error(`unexpected notice: ${message}`); } };
    global.Web = {
        createView: (url) => { const id = views.size + 1; views.set(id, { url, listeners: new Map(), destroyed: false }); return id; },
        on: (id, name, listener) => views.get(id).listeners.set(name, listener),
        emit: () => true,
        showView: () => true,
        hideView: () => true,
        focusView: () => true,
        destroyView: (id) => { views.get(id).destroyed = true; return true; },
    };
    require(path.resolve(__dirname, "..", "dist", "client.js"));

    const preset = { waves: 10, baseSpawns: 4, spawnGrowth: 2, hpGrowth: 1.15, scaleStep: 0.06, scaleMax: 1.9, bossEvery: 5, maxAlive: 8, intermission: 5 };
    handlers.get("hmp-gauntlet:configure")(JSON.stringify({ presets: ["normal"], presetParams: { normal: preset }, defaultPreset: "normal", enemies: [], running: false }));
    const menu = views.get(1);
    assert.strictEqual(menu.url, "fw://resources/hmp-gauntlet/dist/config.html");
    menu.listeners.get("start")({ preset: "normal", pool: [] });
    assert.deepStrictEqual(toServer, [{ name: "hmp-gauntlet:start", payload: JSON.stringify({ preset: "normal", pool: [] }) }]);
    assert.ok(menu.destroyed && released === 1, "starting closes the menu and returns the controls");

    handlers.get("hmp-gauntlet:hud")(JSON.stringify({ active: true, wave: 1, waves: 10, enemies: 7, score: 0 }));
    assert.strictEqual(views.get(2).url, "fw://resources/hmp-gauntlet/dist/hud.html");
    handlers.get("hmp-gauntlet:hud")(JSON.stringify({ active: false }));
    assert.ok(views.get(2).destroyed);
}

runServer()
    .then(runClient)
    .then(() => console.log("hmp-gauntlet bundle contract passed"))
    .finally(() => { global.setTimeout = realSetTimeout; })
    .catch((error) => { console.error(error); process.exitCode = 1; });
