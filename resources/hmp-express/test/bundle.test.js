const assert = require("node:assert");
const path = require("node:path");

const bundle = path.resolve(__dirname, "..", "dist", "server.js");
const logger = { info() {}, warn() {}, error() {}, debug() {} };

function load(world) {
    delete require.cache[bundle];
    const exportsMap = new Map(), handlers = new Map(), intervals = [];
    global.Exports = { register: (name, value) => exportsMap.set(name, value) };
    global.Imports = { get: (name) => {
        if (name === "hmp-lib") return { logger: { create: () => logger }, config: { load: (_p, o) => o.defaults } };
        throw new Error(`Unexpected import ${name}`);
    } };
    global.Events = { on: (name, handler) => handlers.set(name, handler) };
    global.World = world;
    const realSetInterval = global.setInterval;
    global.setInterval = (handler, ms) => { intervals.push({ handler, ms }); return intervals.length; };
    try { require(bundle); }
    finally { global.setInterval = realSetInterval; }
    return { exportsMap, handlers, intervals };
}

// Monday 7 September 1891, 09:59, with the host's train.
const clock = { hour: 9, minute: 59, day: 7, month: 9, year: 0, timeScale: 1 };
const calls = [];
let spawned = false;
const hogwartsExpress = {
    length: 2896,
    stops: [{ id: "hogsmeade", t: 0.31 }],
    spawn: (at) => { calls.push(["spawn", at]); spawned = true; return true; },
    moveTo: () => false,
    depart: (options) => { calls.push(["depart", options.speed]); return true; },
    halt: () => false,
    despawn: () => { calls.push(["despawn"]); spawned = false; return true; },
    get: () => ({ spawned, moving: spawned, departing: spawned, t: 0, speed: 0, target: null, seconds: null }),
};
const current = load({ ...clock, get hour() { return clock.hour; }, get minute() { return clock.minute; }, hogwartsExpress });
assert.deepStrictEqual([...current.exportsMap.keys()], ["train", "status"]);
for (const name of ["trainStopped", "trainEnded", "resourceStop"]) assert.ok(current.handlers.has(name), `no ${name} handler`);
assert.strictEqual(current.exportsMap.get("status")().state, "ready");
assert.deepStrictEqual(current.intervals.map((entry) => entry.ms), [1000]);
clock.hour = 10;
clock.minute = 0;
current.intervals[0].handler();
assert.deepStrictEqual(calls, [["spawn", 0], ["depart", 20]], "the game's own 10:00 Monday departure runs straight through");
assert.strictEqual(current.exportsMap.get("status")().run.departure, "10:00");
current.handlers.get("resourceStop")("hmp-express");
assert.deepStrictEqual(calls.at(-1), ["despawn"]);

// A host without World.hogwartsExpress loads degraded and schedules nothing.
const older = load({ ...clock });
const status = older.exportsMap.get("status")();
assert.strictEqual(status.state, "degraded");
assert.strictEqual(status.train, null);
assert.deepStrictEqual(older.intervals, []);
assert.strictEqual(older.exportsMap.get("train").run(), false);
older.handlers.get("resourceStop")("hmp-express");
console.log("hmp-express bundle contract passed");
