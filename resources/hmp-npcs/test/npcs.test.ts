import assert = require("node:assert");
import { normalizeConfig } from "../server/config";
import { createNpcsService } from "../server/service";
import type { HmpNpcDisposition, HmpNpcIdle } from "../types";

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

// Movement is the owner's alone, validated before the host sees it, and its events reach the owner by resource.
const moves: unknown[][] = [];
const events: Array<{ name: string; payload: { npc: { id: number; resource: string }; [key: string]: unknown } }> = [];
const walker = {
    create(enemyId: string, _x: number, _y: number, _z: number, disposition: HmpNpcDisposition = "hostile") {
        const npc = native.create(enemyId, 0, 0, 0, disposition);
        return Object.assign(npc, {
            idle: "native" as HmpNpcIdle,
            home: null as { x: number; y: number; z: number } | null,
            movement: { mode: "path" as const, waypoint: 1, waypoints: 2, lap: 0, paused: false },
            waypoints: [{ x: 1, y: 2, z: 3, wait: 0, gait: "walk" as const }],
            moveAlong(...args: unknown[]) { moves.push(["along", ...args]); return true; },
            moveTo(...args: unknown[]) { moves.push(["to", ...args]); return true; },
            stop() { moves.push(["stop"]); },
            pause() { moves.push(["pause"]); },
            resume() { moves.push(["resume"]); },
        });
    },
};
const paths = createNpcsService({
    config: { maximumManagedNpcs: 8, maximumPerResource: 8 },
    native: walker,
    emit: (name, payload) => events.push({ name, payload: payload as never }),
});
const guard = paths.spawn({ resource: "patrols", enemyId: "Poacher_Grunt", position: { x: 0, y: 0, z: 0 }, disposition: "friendly" });
const route = [{ x: 100, y: 0, z: 90, wait: 5 }, { x: 900, y: 0, z: 90, gait: "jog" as const }];
assert.strictEqual(paths.movement.along(guard.id, "patrols", route, { loop: "pingpong", speedScale: 1.5 }), true);
assert.deepStrictEqual(moves.at(-1), ["along", route, { loop: "pingpong", speedScale: 1.5 }]);
assert.strictEqual(paths.movement.along(guard.id, "intruder", route), false, "another resource cannot steer it");
assert.strictEqual(moves.length, 1);
assert.throws(() => paths.movement.along(guard.id, "patrols", []), /1 to 64 waypoints/);
assert.throws(() => paths.movement.along(guard.id, "patrols", [{ x: 0, y: 0, z: Number.NaN }]), /waypoint 0\.z/);
assert.throws(() => paths.movement.along(guard.id, "patrols", [{ x: 0, y: 0, z: 0, gait: "crawl" as never }]), /gait must be one of/);
assert.throws(() => paths.movement.to(guard.id, "patrols", { x: 0, y: 0, z: 0 }, { speedScale: 9 }), /speedScale/);
assert.strictEqual(paths.movement.to(guard.id, "patrols", { x: 5, y: 6, z: 7 }, { then: "wander" }), true);
assert.deepStrictEqual(moves.at(-1), ["to", 5, 6, 7, { then: "wander" }]);
assert.deepStrictEqual([paths.movement.pause(guard.id, "patrols"), paths.movement.resume(guard.id, "patrols"), paths.movement.stop(guard.id, "patrols")], [true, true, true]);
assert.deepStrictEqual(moves.slice(-3), [["pause"], ["resume"], ["stop"]]);
assert.strictEqual(paths.movement.stop(guard.id, "intruder"), false);
assert.strictEqual(paths.movement.setIdle(guard.id, "patrols", "stand", { x: 1, y: 2, z: 3 }), true);
assert.deepStrictEqual(paths.movement.get(guard.id), {
    state: { mode: "path", waypoint: 1, waypoints: 2, lap: 0, paused: false },
    waypoints: [{ x: 1, y: 2, z: 3, wait: 0, gait: "walk" }],
    idle: "stand",
    home: { x: 1, y: 2, z: 3 },
});
assert.throws(() => paths.movement.setIdle(guard.id, "patrols", "sleep" as never), /idle must be one of/);
assert.strictEqual(paths.waypoint(guard.id, 1, 0), true);
assert.strictEqual(paths.moveEnded(guard.id, "replaced"), true);
assert.deepStrictEqual(events.map((event) => [event.name, event.payload.npc.resource, event.payload.index ?? event.payload.reason]), [
    ["hmp:npcs:waypoint", "patrols", 1],
    ["hmp:npcs:moveEnded", "patrols", "replaced"],
]);
assert.strictEqual(paths.moveEnded(9999, "arrived"), false, "an NPC this service does not manage is not forwarded");
assert.strictEqual(events.length, 2);

// A host before NPC paths: the handle has no moveAlong, so every call is a plain false.
const older = createNpcsService({ config: { maximumManagedNpcs: 2, maximumPerResource: 2 }, native });
const still = older.spawn({ resource: "patrols", enemyId: "Wolf", position: { x: 0, y: 0, z: 0 } });
assert.strictEqual(older.movement.along(still.id, "patrols", route), false);
assert.strictEqual(older.movement.setIdle(still.id, "patrols", "wander"), false);
assert.strictEqual(older.movement.get(still.id), null);

console.log("hmp-npcs tests passed");
