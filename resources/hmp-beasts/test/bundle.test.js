const assert = require("node:assert");
const path = require("node:path");

const exportsMap = new Map(), handlers = new Map(), emitted = [], commands = [];
const player = { id: 1, nickname: "Smoke" };
const rows = new Map();
const bag = new Map();
let nextEntry = 1;
global.Exports = { register: (name, value) => exportsMap.set(name, value) };
global.Imports = { get: (name) => {
  if (name === "hmp-lib") return {
    logger: { create: () => ({ info() {}, warn() {}, error() {} }) },
    config: { load: (_p, o) => o.defaults },
    command: { createRouter: () => ({ register: (command) => commands.push(command), handle: async () => true }) },
  };
  if (name === "hmp-ui") return { context: async () => null, alert: async () => null, input: async () => null, notify: () => true };
  if (name === "hmp-mysql") return {
    ready: async () => true, migrate: async () => ({ resource: "hmp-beasts", applied: [1] }),
    scalar: async (_sql, values) => rows.get(values[0]) ?? null,
    update: async (_sql, values) => { rows.set(values[0], values[1]); return 1; },
  };
  if (name === "hmp-core") return { characters: { active: () => ({ id: 7 }) } };
  throw new Error(`Unexpected import ${name}`);
} };
global.PlayerManager = { getAll: () => [player] };
global.Events = { on: (name, handler) => handlers.set(name, handler), emit: (name, payload) => emitted.push({ name, payload }) };
global.Beast = {
  bagOf: () => [...bag.values()],
  giveCaptured: (_player, beast) => { const entry = { id: nextEntry++, color: "Default", gender: "male", name: "", ...beast }; bag.set(entry.id, entry); return entry; },
  takeCaptured: (_player, id) => bag.delete(id),
  create: (species) => ({ id: 99, species, capturable: false }),
};
require(path.resolve(__dirname, "..", "dist", "server.js"));
assert.deepStrictEqual([...exportsMap.keys()], ["bag", "menu", "status"]);
assert.deepStrictEqual(commands, ["beasts"]);
for (const name of ["beastCaptured", "beastReleased", "chatCommand", "hmp:character:loaded", "hmp:character:unloading", "hmp:session:ended", "resourceStart", "resourceStop"]) {
  assert.ok(handlers.has(name), `no ${name} handler`);
}
handlers.get("resourceStart")("hmp-beasts");

setTimeout(async () => {
  assert.strictEqual(exportsMap.get("status")().state, "ready");
  // The player already had character 7 loaded, so its (empty) bag is live; a catch is kept.
  const caught = { id: nextEntry++, species: "Niffler", color: "Default", gender: "female", name: "" };
  bag.set(caught.id, caught);
  handlers.get("beastCaptured")(player, caught);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.strictEqual(JSON.parse(rows.get(7)).length, 1);
  assert.ok(emitted.some((entry) => entry.name === "hmp:beasts:captured"));
  handlers.get("resourceStop")("hmp-beasts");
  console.log("hmp-beasts bundle contract passed");
}, 20);
