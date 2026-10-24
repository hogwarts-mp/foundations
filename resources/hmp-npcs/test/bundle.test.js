const assert = require("node:assert");
const path = require("node:path");

const exportsMap = new Map();
const handlers = new Map();
let nextId = 10;
const emitted = [];
const walks = [];
global.Exports = { register: (name, value) => exportsMap.set(name, value) };
global.Imports = { get: () => ({ logger: { create: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }, config: { load: (_path, options) => options.defaults } }) };
global.Events = { on: (name, handler) => handlers.set(name, handler), emit: (name, payload) => emitted.push({ name, payload }) };
global.NPC = { create: (enemyId, _x, _y, _z, disposition = "hostile", ownerId) => ({
    id: nextId++, enemyId, disposition, ownerId, alive: true, scale: 1, health: 100, maxHealth: 100,
    setScale(value) { this.scale = value; }, setMaxHealth(value) { this.maxHealth = value; }, setHealth(value) { this.health = value; }, destroy() { this.alive = false; },
    moveAlong: (waypoints, options) => { walks.push({ waypoints, options }); return true; },
    setVirtualWorld: (...place) => { walks.push({ place }); },
}) };

require(path.resolve(__dirname, "..", "dist", "server.js"));
assert.deepStrictEqual([...exportsMap.keys()], ["catalog", "spawn", "destroy", "clear", "get", "list", "status", "movement", "setVirtualWorld"]);
assert.strictEqual(exportsMap.get("catalog").list().length, 39);
const npc = exportsMap.get("spawn")({ resource: "smoke", enemyId: "Wolf", position: { x: 0, y: 0, z: 0 } });
assert.strictEqual(npc.id, 10);
assert.strictEqual(exportsMap.get("movement").along(10, "smoke", [{ x: 1, y: 2, z: 3 }], { loop: "loop" }), true);
assert.deepStrictEqual(walks, [{ waypoints: [{ x: 1, y: 2, z: 3 }], options: { loop: "loop" } }]);
assert.strictEqual(exportsMap.get("setVirtualWorld")(10, "smoke", 3, "Dungeon_Crypt"), true);
assert.deepStrictEqual(walks.at(-1), { place: [3, "Dungeon_Crypt"] });
handlers.get("npcWaypoint")({ id: 10 }, 0, 1);
handlers.get("npcMoveEnded")({ id: 10 }, "stopped");
assert.deepStrictEqual(emitted.map((event) => [event.name, event.payload.npc.resource]), [["hmp:npcs:waypoint", "smoke"], ["hmp:npcs:moveEnded", "smoke"]]);
handlers.get("npcDied")(10);
assert.strictEqual(exportsMap.get("status")().managed, 0);
require(path.resolve(__dirname, "..", "dist", "client.js"));

console.log("hmp-npcs bundle contract passed");
