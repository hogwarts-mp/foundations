const assert = require("node:assert");
const path = require("node:path");

const exportsMap = new Map(), handlers = new Map();
const messages = [], emitted = [];
const player = { id: 1, nickname: "Smoke", emit: (name, payload) => emitted.push({ name, payload }), sendChat: (message) => messages.push(message) };
let nativePolicy = null;
global.Exports = { register: (name, value) => exportsMap.set(name, value) };
global.Imports = { get: (name) => name === "hmp-core"
  ? { groups: { has: async () => true } }
  : { logger: { create: () => ({ info() {}, warn() {}, error() {} }) }, config: { load: (_p, o) => o.defaults } } };
global.PlayerManager = { getAll: () => [player], getById: (id) => id === player.id ? player : null };
let rules = { who: "none" };
const configured = [];
global.Pvp = {
  setPolicy: (fn) => { nativePolicy = fn || null; return true; },
  getVitals: () => null,
  getRules: () => ({ ...rules }),
  configure: (patch) => { configured.push(patch); rules = { ...rules, ...patch }; return { ...rules }; },
};
global.Events = { on: (name, handler) => handlers.set(name, handler), emit() {} };
require(path.resolve(__dirname, "..", "dist", "server.js"));
assert.deepStrictEqual([...exportsMap.keys()], ["policy", "mode", "vitals", "status"]);
assert.strictEqual(typeof nativePolicy, "function");
assert.deepStrictEqual(configured, []);
assert.ok(handlers.has("resourceStop"));
assert.ok(handlers.has("chatCommand"));
assert.ok(handlers.has("pvpRulesChanged"));
handlers.get("chatCommand")(player, "", "pvp", ["lethal", "on"]);

setImmediate(() => {
  assert.strictEqual(exportsMap.get("mode").isLethal(), true);
  assert.deepStrictEqual(configured, [{ who: "everyone" }]);
  assert.ok(messages.some((message) => message.includes("LETHAL PvP ON")));
  assert.ok(emitted.some((entry) => entry.name === "hmp-pvp:mode" && JSON.parse(entry.payload).enabled === true));
  // Someone else narrowing the rules ends lethal mode without hmp-pvp overwriting their choice.
  rules = { who: "teams" };
  handlers.get("pvpRulesChanged")({ ...rules });
  assert.strictEqual(exportsMap.get("mode").isLethal(), false);
  assert.deepStrictEqual(configured, [{ who: "everyone" }]);
  exportsMap.get("mode").setLethal(true, { resource: "test" });
  handlers.get("resourceStop")("hmp-pvp");
  assert.deepStrictEqual(configured.at(-1), { who: "none" });
  assert.strictEqual(nativePolicy, null);

  const clientExports = new Map(), clientHandlers = new Map();
  global.Exports = { register: (name, value) => clientExports.set(name, value) };
  global.Events = { on: (name, handler) => clientHandlers.set(name, handler) };
  delete global.Pvp;
  require(path.resolve(__dirname, "..", "dist", "client.js"));
  assert.deepStrictEqual([...clientExports.keys()], ["mode"]);
  clientHandlers.get("hmp-pvp:mode")(JSON.stringify({ enabled: true }));
  assert.strictEqual(clientExports.get("mode").isLethal(), true);
  clientHandlers.get("resourceStop")("hmp-pvp");
  assert.strictEqual(clientExports.get("mode").isLethal(), false);
  console.log("hmp-pvp bundle contract passed");
});
