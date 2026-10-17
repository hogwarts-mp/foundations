import assert = require("node:assert");
import { normalizeConfig } from "../server/config";
import { createNpcsService } from "../server/service";
import type { HmpNpcDisposition } from "../types";

assert.deepStrictEqual(normalizeConfig({ maximumManagedNpcs: 8, maximumPerResource: 4 }), {
    maximumManagedNpcs: 8,
    maximumPerResource: 4,
});
assert.throws(() => normalizeConfig({ maximumManagedNpcs: 2, maximumPerResource: 3 }), /cannot exceed/);

let nextId = 1;
const destroyed: number[] = [];
const native = {
    create(enemyId: string, _x: number, _y: number, _z: number, disposition: HmpNpcDisposition = "hostile", ownerId?: number) {
        const npc = {
            id: nextId++, enemyId, disposition, ownerId, alive: true, scale: 1, health: 100, maxHealth: 100,
            setScale(value: number) { this.scale = value; },
            setMaxHealth(value: number) { this.maxHealth = value; },
            setHealth(value: number) { this.health = value; },
            destroy() { destroyed.push(this.id); this.alive = false; },
        };
        return npc;
    },
};
const service = createNpcsService({ config: { maximumManagedNpcs: 3, maximumPerResource: 2 }, native });
assert.strictEqual(service.catalog.has("Goblin_Grunt"), true);
assert.strictEqual(service.catalog.list().length, 39);
assert.throws(() => service.spawn({ resource: "arena", enemyId: "Nope", position: { x: 0, y: 0, z: 0 } }), /Unknown/);
const first = service.spawn({ resource: "arena", enemyId: "Goblin_Grunt", position: { x: 1, y: 2, z: 3 }, maxHealth: 250, scale: 1.2 });
assert.deepStrictEqual({ id: first.id, health: first.health, maxHealth: first.maxHealth, scale: first.scale }, { id: 1, health: 250, maxHealth: 250, scale: 1.2 });
service.spawn({ resource: "arena", enemyId: "Wolf", position: { x: 1, y: 2, z: 3 } });
assert.throws(() => service.spawn({ resource: "arena", enemyId: "Wolf", position: { x: 1, y: 2, z: 3 } }), /limit reached/);
const other = service.spawn({ resource: "quest", enemyId: "Inferius", position: { x: 1, y: 2, z: 3 } });
assert.strictEqual(service.status().managed, 3);
assert.strictEqual(service.destroy(other.id, "arena"), false);
assert.strictEqual(service.died(first.id), true);
assert.strictEqual(service.clear("arena"), 1);
assert.deepStrictEqual(destroyed, [2]);
// An id that crosses a resource boundary as a string still finds the NPC; it must leave the registry too.
const loose = service.spawn({ resource: "quest", enemyId: "Wolf", position: { x: 1, y: 2, z: 3 } });
assert.strictEqual(service.destroy(String(loose.id) as unknown as number, "quest"), true);
assert.strictEqual(service.status().managed, 1);
assert.strictEqual(service.destroy(loose.id, "quest"), false);
service.stop();
assert.deepStrictEqual(destroyed, [2, 4, 3]);
assert.throws(() => service.catalog.list().push({ id: "x", label: "x" }) && service.spawn({ resource: "x", enemyId: "Wolf", position: { x: 0, y: 0, z: 0 } }), /stopped/);

console.log("hmp-npcs tests passed");
