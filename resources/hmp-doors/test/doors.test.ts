import assert = require("node:assert");
import policyModule = require("../server/policy");
import configModule = require("../server/config");
import serviceModule = require("../server/service");
import clientModule = require("../client/doors");
import type { HmpDoorRule } from "../types";

const { evaluateRules } = policyModule;
const { normalizeRule } = configModule;
const { createDoorService, METADATA_KEY } = serviceModule;
const { createDoorClient, doorAnchor, normalizeLabelOptions, levelSegment } = clientModule;

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
    assert.deepStrictEqual(guest.lockDoors, []);

    // A path selector targets one placement where a bare name would hit every door sharing it.
    const SHOP = "/Game/Maps/Hogsmeade/Sub_A.Sub_A:PersistentLevel.BP_Door_Template2";
    const locking: HmpDoorRule[] = [
        normalizeRule({ priority: 1000, action: "allow", doors: "*" }, 0),
        normalizeRule({ priority: 500, action: "lock", doors: [SHOP] }, 1),
    ];
    const visitor = evaluateRules(locking, []);
    assert.deepStrictEqual(visitor.lockDoors, [SHOP]);
    // Also an unlock exception, so a client too old to honour lockDoors leaves it alone under unlockAll.
    assert.deepStrictEqual(visitor.unlockAllExcept, [SHOP]);
    assert.strictEqual(visitor.unlockAll, true);

    // Lock beats deny and allow at equal priority; a personal grant still beats lock.
    const tie = [
        normalizeRule({ priority: 100, action: "allow", doors: ["Tie"] }, 0),
        normalizeRule({ priority: 100, action: "deny", doors: ["Tie"] }, 1),
        normalizeRule({ priority: 100, action: "lock", doors: ["Tie"] }, 2),
    ];
    assert.deepStrictEqual(evaluateRules(tie, []).lockDoors, ["Tie"]);
    const granted = evaluateRules(tie, [], ["Tie"]);
    assert.deepStrictEqual(granted.lockDoors, []);
    assert.deepStrictEqual(granted.unlockDoors, ["Tie"]);

    assert.throws(() => normalizeRule({ priority: 1, action: "lock", locks: ["GateLock"] }, 0), /only to a doors target/);
    assert.throws(() => normalizeRule({ priority: 1, action: "lock", doors: "*" }, 0), /not '\*'/);
    assert.throws(() => normalizeRule({ priority: 1, action: "seal", doors: ["x"] }, 0), /allow, deny or lock/);

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
    const lockedCalls: Array<[string, boolean | undefined]> = [];
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
            setLocked: (selector, locked) => { lockedCalls.push([selector, locked]); return 1; },
        },
    });
    assert.deepStrictEqual(events.map((event) => event.name), ["hmp-doors:ready"]);
    client.apply({ unlockLocks: ["GateLock"], superAlohomora: true, unlockAll: true });
    client.apply({ unlockLocks: [], superAlohomora: false, unlockAll: false });
    assert.deepStrictEqual(lockCalls, [["GateLock", true], ["GateLock", false]]);
    assert.deepStrictEqual(superCalls, [true, false]);
    assert.strictEqual(physical.length, 2);
    // The physical policy carries lockDoors through to the native untouched.
    client.apply({ unlockAll: true, lockDoors: ["/Game/M.M:PersistentLevel.D"] });
    assert.deepStrictEqual((physical[physical.length - 1] as { lockDoors: string[] }).lockDoors, ["/Game/M.M:PersistentLevel.D"]);
    assert.strictEqual(client.diagnostic({ action: "set-locked", selector: "/Game/M.M:PersistentLevel.D" }), 1);
    assert.deepStrictEqual(lockedCalls, [["/Game/M.M:PersistentLevel.D", true]]);

    // list echoes the nearest few into chat, each path on its own line so a selection copies cleanly.
    const chat: string[] = [];
    const listed = createDoorClient({
        events: { emitServer: () => { /* ready ping */ } },
        notify: (message) => { chat.push(message); },
        doors: {
            setLock: () => true, superAlohomora: () => true, setPolicy: () => { /* unused */ },
            openNearby: () => 0, unlockNearby: () => 0, setOpen: () => true, setLocked: () => 0,
            list: () => Array.from({ length: 7 }, (_, i) => ({
                name: `BP_Door_${i}`, cls: "Door", dist: i * 100, bearing: 0,
                path: `/Game/Maps/HM/Sub.Sub:PersistentLevel.BP_Door_${i}`,
            })),
        },
    });
    listed.list(800);
    assert.strictEqual(chat[0], "[doors] 7 door(s) within 800cm; nearest 5 below, 2 more in the console");
    assert.strictEqual(chat[1], "0cm BP_Door_0 [Door]");
    assert.strictEqual(chat[2], "/Game/Maps/HM/Sub.Sub:PersistentLevel.BP_Door_0");
    assert.strictEqual(chat.length, 11);
    listed.stop();

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
            list: () => nearby, openNearby: () => 0, unlockNearby: () => 0, setOpen: () => true, setLocked: () => 0,
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

    assert.strictEqual(levelSegment("/Game/Maps/Hogsmeade/Sub_A.Sub_A:PersistentLevel.BP_Door_Template2"), "Sub_A");
    assert.strictEqual(levelSegment(undefined), "");
    assert.strictEqual(levelSegment("BP_Door_Template2"), "BP_Door_Template2");

    // Two doors sharing a name: the label must carry the level, and take it from the nearer one.
    nearby.push(
        { name: "BP_Door_Template2", cls: "Door", dist: 700, bearing: 5, path: "/Game/Maps/HM/Far.Far:PersistentLevel.BP_Door_Template2" } as (typeof nearby)[number],
        { name: "BP_Door_Template2", cls: "Door", dist: 120, bearing: 5, path: "/Game/Maps/HM/Near.Near:PersistentLevel.BP_Door_Template2" } as (typeof nearby)[number],
    );
    intervals.get(handle)?.();
    assert.strictEqual(prompts.length, 2);
    assert.strictEqual(prompts[1].label, "BP_Door_Template2 (Near)");

    // A door whose name is unique in the scan stays unadorned.
    nearby.length = 0;
    nearby.push({ name: "BP_Solo_Door", cls: "Door", dist: 90, bearing: 0, path: "/Game/Maps/HM/Only.Only:PersistentLevel.BP_Solo_Door" } as (typeof nearby)[number]);
    intervals.get(handle)?.();
    assert.strictEqual(prompts.length, 3);
    assert.strictEqual(prompts[2].label, "BP_Solo_Door");

    // A located door is anchored exactly and no longer needs a usable bearing to be labelled.
    nearby.push({ name: "BP_Located_Door", cls: "Door", dist: 10, bearing: 999, x: 7, y: 8, z: 9 } as (typeof nearby)[number]);
    intervals.get(handle)?.();
    assert.strictEqual(prompts.length, 4);
    assert.strictEqual(prompts[3].label, "BP_Located_Door");
    assert.deepStrictEqual([prompts[3].x, prompts[3].y, prompts[3].z], [7, 8, 129]);

    assert.strictEqual(labelClient.diagnostic({ action: "label-off" }), true);
    assert.strictEqual(intervals.size, 0);
    assert.strictEqual(hidden, 1);
    assert.strictEqual(labelClient.status().labels, null);
    assert.strictEqual(labelClient.diagnostic({ action: "label-off" }), false);
}

run().then(() => console.log("hmp-doors tests passed"));
