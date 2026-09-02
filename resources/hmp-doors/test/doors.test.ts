import assert = require("node:assert");
import policyModule = require("../server/policy");
import configModule = require("../server/config");
import serviceModule = require("../server/service");
import clientModule = require("../client/doors");
import type { HmpDoorRule } from "../types";

const { evaluateRules } = policyModule;
const { normalizeRule } = configModule;
const { createDoorService, METADATA_KEY } = serviceModule;
const { createDoorClient, doorAnchor, normalizeLabelOptions } = clientModule;

async function run(): Promise<void> {
    const rules: HmpDoorRule[] = [
        normalizeRule({ priority: 1000, action: "allow", doors: "*" }, 0),
        normalizeRule({ priority: 1000, action: "deny", doors: ["Headmaster"] }, 1),
        normalizeRule({ priority: 500, action: "allow", doors: ["Headmaster"], match: { groups: [{ key: "staff", minimumGrade: 2 }] } }, 2),
        normalizeRule({ priority: 800, action: "allow", locks: ["GateLock"] }, 3),
        normalizeRule({ priority: 700, action: "allow", alohomora: true, match: { groups: [{ key: "job:auror" }] } }, 4),
    ];
    const guest = evaluateRules(rules, [], []);
    assert.strictEqual(guest.unlockAll, true);
    assert.deepStrictEqual(guest.unlockAllExcept, ["Headmaster"]);
    assert.deepStrictEqual(guest.unlockLocks, ["GateLock"]);
    assert.strictEqual(guest.superAlohomora, false);

    const staff = evaluateRules(rules, [{ key: "staff", grade: 2 }], ["SecretPassage"]);
    assert.deepStrictEqual(staff.unlockAllExcept, []);
    assert.deepStrictEqual(staff.unlockDoors, ["Headmaster", "SecretPassage"]);
    const auror = evaluateRules(rules, [{ key: "job:auror", grade: 0 }]);
    assert.strictEqual(auror.superAlohomora, true);
    assert.throws(() => normalizeRule({ priority: 1, action: "allow", doors: "*", locks: ["x"] }, 0), /exactly one/);

    const player = { id: 7, nickname: "Test", emitted: [] as Array<{ name: string; payload: unknown }>, emit(name: string, payload?: unknown) { this.emitted.push({ name, payload }); } };
    const metadata = new Map<string, unknown>();
    const core = {
        characters: { active: () => ({ id: 42, accountId: 1, slot: 1, name: "Test", status: "active", createdAt: "", updatedAt: "", deletedAt: null }) },
        groups: { effective: async () => [{ scope: "character", key: "staff", grade: 2, metadata: {} }] },
        metadata: {
            getCharacter: async (_id: number, key: string) => metadata.get(key),
            setCharacter: async (_id: number, key: string, value: unknown) => { metadata.set(key, value); return value; },
        },
    };
    const service = createDoorService({ core: core as never, config: { command: "doors", enableCommands: true, adminGroups: [], rules }, players: () => [player] });
    assert.strictEqual(await service.grants.grant(player, "SecretPassage"), true);
    assert.deepStrictEqual(metadata.get(METADATA_KEY), ["SecretPassage"]);
    assert.deepStrictEqual(await service.grants.list(player), ["SecretPassage"]);
    assert.strictEqual(await service.grants.revoke(player, "SecretPassage"), true);
    assert.deepStrictEqual(await service.grants.list(player), []);
    assert.ok(player.emitted.some((event) => event.name === "hmp-doors:policy"));

    const lockCalls: Array<[string, boolean | undefined]> = [];
    const superCalls: boolean[] = [];
    const physical: unknown[] = [];
    const events: Array<{ name: string; payload: unknown }> = [];
    const client = createDoorClient({
        events: { emitServer: (name, payload) => events.push({ name, payload }) },
        doors: {
            setLock: (id, unlocked) => { lockCalls.push([id, unlocked]); return true; },
            superAlohomora: (enabled = true) => { superCalls.push(enabled); return true; },
            setPolicy: (value) => { physical.push(value); },
            list: () => [], openNearby: () => 0, unlockNearby: () => 0, setOpen: () => true,
        },
    });
    assert.deepStrictEqual(events.map((event) => event.name), ["hmp-doors:ready"]);
    client.apply({ unlockLocks: ["GateLock"], superAlohomora: true, unlockAll: true });
    client.apply({ unlockLocks: [], superAlohomora: false, unlockAll: false });
    assert.deepStrictEqual(lockCalls, [["GateLock", true], ["GateLock", false]]);
    assert.deepStrictEqual(superCalls, [true, false]);
    assert.strictEqual(physical.length, 2);
    // Label mode is inert without the Hud and LocalPlayer natives rather than throwing.
    assert.strictEqual(client.diagnostic({ action: "label" }), false);
    client.stop();
    assert.strictEqual(client.status().stopped, true);

    assert.deepStrictEqual(normalizeLabelOptions({ radius: 99999 }), { radius: 20000, intervalMs: 250, offsetZ: 120 });
    assert.deepStrictEqual(normalizeLabelOptions({}), { radius: 1500, intervalMs: 250, offsetZ: 120 });

    // On a client that reports door positions the anchor is the door's own, bearing ignored entirely.
    const options = { radius: 1500, intervalMs: 250, offsetZ: 120 };
    const located = doorAnchor({ x: 0, y: 0, z: 0 }, 90, { name: "D", cls: "Door", dist: 200, bearing: 999, x: 40, y: 50, z: 60 }, options);
    assert.deepStrictEqual(located, { x: 40, y: 50, z: 180 });

    // Falling back, the mod computes bearing as atan2(dy, dx) - yaw, so adding the yaw back must
    // invert it: facing +Y (yaw 90) with a door dead ahead (bearing 0) puts it 200cm along +Y.
    const ahead = doorAnchor({ x: 0, y: 0, z: 0 }, 90, { name: "D", cls: "Door", dist: 200, bearing: 0 }, options);
    assert.strictEqual(Math.round(ahead.x), 0);
    assert.strictEqual(Math.round(ahead.y), 200);
    assert.strictEqual(ahead.z, 120);
    const behind = doorAnchor({ x: 0, y: 0, z: 0 }, 0, { name: "D", cls: "Door", dist: 200, bearing: 180 }, options);
    assert.strictEqual(Math.round(behind.x), -200);
    assert.strictEqual(Math.round(behind.y), 0);

    const prompts: Array<{ key: string; label: string; x: number; y: number; z: number }> = [];
    const intervals = new Map<number, () => void>();
    let hidden = 0;
    let handle = 0;
    const nearby = [
        // dist -1 and bearing 999 are the native's "unlocated actor" / "unknown rotation" sentinels.
        // Neither can be turned into an anchor, and -1 must not win the nearest-door comparison.
        { name: "BP_Unlocated_Door", cls: "Door", dist: -1, bearing: 999 },
        { name: "BP_Unknown_Bearing_Door", cls: "Door", dist: 50, bearing: 999 },
        { name: "BP_Far_Door", cls: "Door", dist: 900, bearing: 10 },
        // No x/y/z, so this exercises the fallback against a client without the door-position change.
        { name: "BP_Hogsmeade_Shop_Door", cls: "Door", dist: 200, bearing: 0 },
    ];
    const labelClient = createDoorClient({
        events: { emitServer: () => { /* ready ping */ } },
        doors: {
            setLock: () => true, superAlohomora: () => true, setPolicy: () => { /* unused */ },
            list: () => nearby, openNearby: () => 0, unlockNearby: () => 0, setOpen: () => true,
        },
        hud: {
            showPrompt: (key, label, x, y, z) => { prompts.push({ key, label, x, y, z }); },
            hidePrompt: () => { hidden++; },
        },
        localPlayer: {
            getPosition: () => ({ x: 1000, y: 2000, z: 300 }),
            getRotation: () => ({ pitch: 0, yaw: 0, roll: 0 }),
        },
        timers: {
            setInterval: (fn: () => void, _ms: number) => { const id = ++handle; intervals.set(id, fn); return id; },
            clearInterval: (id: unknown) => { intervals.delete(id as number); },
        },
    });

    assert.strictEqual(labelClient.diagnostic({ action: "label", radius: 1500 }), true);
    assert.strictEqual(intervals.size, 1);
    // Nearest door wins; the distance rides in the prompt's key slot so it renders as "[2.0m] name".
    assert.strictEqual(prompts.length, 1);
    assert.strictEqual(prompts[0].label, "BP_Hogsmeade_Shop_Door");
    assert.strictEqual(prompts[0].key, "2.0m");
    assert.strictEqual(Math.round(prompts[0].x), 1200);
    assert.strictEqual(Math.round(prompts[0].y), 2000);
    assert.strictEqual(prompts[0].z, 420);

    // A standing player produces the same anchor, so the held prompt is not reissued every tick.
    intervals.get(handle)?.();
    assert.strictEqual(prompts.length, 1);

    // A located door is anchored exactly and no longer needs a usable bearing to be labelled.
    nearby.push({ name: "BP_Located_Door", cls: "Door", dist: 10, bearing: 999, x: 7, y: 8, z: 9 } as (typeof nearby)[number]);
    intervals.get(handle)?.();
    assert.strictEqual(prompts.length, 2);
    assert.strictEqual(prompts[1].label, "BP_Located_Door");
    assert.deepStrictEqual([prompts[1].x, prompts[1].y, prompts[1].z], [7, 8, 129]);

    assert.strictEqual(labelClient.diagnostic({ action: "label-off" }), true);
    assert.strictEqual(intervals.size, 0);
    assert.strictEqual(hidden, 1);
    assert.strictEqual(labelClient.status().labels, null);
    assert.strictEqual(labelClient.diagnostic({ action: "label-off" }), false);
}

run().then(() => console.log("hmp-doors tests passed"));
