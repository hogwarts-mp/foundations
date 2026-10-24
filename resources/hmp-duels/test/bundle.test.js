const assert = require("node:assert"); const path = require("node:path");
const serverExports = new Map(), serverHandlers = new Map();
const kneels = [], timers = [];
const player = { id: 1, nickname: "Smoke", emit() {}, sendChat() {}, endKneel: () => { kneels.push(1); return true; } };
let definition = null, rules = {};
const activity = {
  definitions: { register: (value) => { definition = value; return async () => 0; } },
  sessions: { forPlayer: () => [], get: () => null, create: async () => { throw new Error("unused"); }, cancel: async () => {}, complete: async () => {}, start: async () => {} },
  invitations: { list: () => [], invite: async () => {}, accept: async () => {}, decline: async () => {}, cancel: async () => {} },
};
const pvp = { policy: { register: () => () => true }, status: () => ({}) };
const ui = { notify() {}, alert: async () => null, close() {} };
global.Exports = { register: (name, value) => serverExports.set(name, value) };
global.Imports = { get: (name) => name === "hmp-lib" ? { logger: { create: () => ({ info() {}, warn() {}, error() {} }) }, config: { load: (_p, o) => o.defaults }, player: { find: () => null } } : name === "hmp-core" ? {} : name === "hmp-activities" ? activity : name === "hmp-pvp" ? pvp : ui };
global.PlayerManager = { getById: () => player };
global.Events = { on: (name, handler) => serverHandlers.set(name, handler) };
global.Pvp = { getRules: () => rules };
const realSetTimeout = global.setTimeout;
global.setTimeout = (handler, ms) => { timers.push({ handler, ms }); return timers.length; };
require(path.resolve(__dirname, "..", "dist", "server.js"));
global.setTimeout = realSetTimeout;
assert.deepStrictEqual([...serverExports.keys()], ["challenge", "accept", "decline", "cancel", "forfeit", "status"]);
assert.ok(serverHandlers.has("playerDied")); assert.ok(serverHandlers.has("pvpDefeat")); assert.ok(serverHandlers.has("hmp:activities:invitation:expired"));
// A knock-out's loser is stood up with endKneel only when the host's rules hold kneels; an older host's have no kneelSeconds.
const ko = { session: { id: "s", participants: [{ playerId: 1, nickname: "Smoke" }, { playerId: 2, nickname: "Rival" }] }, result: { winnerId: 2, loserId: 1, reason: "ko" } };
definition.onCompleted(ko);
assert.strictEqual(timers.length, 0);
rules = { kneelSeconds: 0 };
definition.onCompleted(ko);
assert.strictEqual(timers.at(-1).ms, 4000);
timers.at(-1).handler();
assert.deepStrictEqual(kneels, [1]);
delete player.endKneel; // and a player object without it is left alone
definition.onCompleted(ko); timers.at(-1).handler();

// The client may only use the host's current client Pvp surface: the opponent meter.
const clientHandlers = new Map(), calls = [], meters = [];
global.Events = { on: (name, handler) => clientHandlers.set(name, handler), emitServer() {} };
global.Pvp = { showMeter: (id) => { meters.push(id); return "ok"; } };
delete global.Imports; delete global.LocalPlayer; global.Game = { notify: (value) => calls.push(value) };
require(path.resolve(__dirname, "..", "dist", "client.js"));
assert.ok(clientHandlers.has("hmp-duels:countdown")); assert.ok(clientHandlers.has("hmp-duels:end"));
clientHandlers.get("hmp-duels:countdown")({ seconds: 3, opponentId: 2, opponentName: "Smoke" });
clientHandlers.get("hmp-duels:start")({ opponentId: 2, opponentName: "Smoke" });
clientHandlers.get("hmp-duels:end")({ result: "win", opponentName: "Smoke" });
assert.ok(calls.some((value) => String(value).includes("Victory")));
assert.deepStrictEqual(meters, [null, 2, 2, null]);
console.log("hmp-duels bundle contract passed");
