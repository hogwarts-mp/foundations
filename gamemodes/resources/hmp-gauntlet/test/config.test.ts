import assert = require("node:assert");
import { DEFAULT_CONFIG, normalizeConfig } from "../server/config";

const defaults = normalizeConfig(undefined);
assert.deepStrictEqual(defaults.presets, DEFAULT_CONFIG.presets);
assert.strictEqual(defaults.defaultPreset, "normal");
assert.deepStrictEqual(defaults.bosses, DEFAULT_CONFIG.bosses);
assert.notStrictEqual(defaults.bosses, DEFAULT_CONFIG.bosses, "defaults must be copied, not shared");
assert.strictEqual(defaults.interaction.enabled, false);
assert.deepStrictEqual(normalizeConfig("not an object").presets, DEFAULT_CONFIG.presets);

// A partial preset keeps the rest of its own defaults; a new preset falls back to normal's.
const presets = normalizeConfig({ presets: { easy: { waves: 3, maxAlive: "x" }, insane: { waves: 2, baseSpawns: 9 }, junk: 4 }, defaultPreset: "insane" });
assert.deepStrictEqual(presets.presets.easy, { ...DEFAULT_CONFIG.presets.easy, waves: 3 });
assert.deepStrictEqual(presets.presets.insane, { ...DEFAULT_CONFIG.presets.normal, waves: 2, baseSpawns: 9 });
assert.ok(!("junk" in presets.presets));
assert.strictEqual(presets.defaultPreset, "insane");
assert.strictEqual(normalizeConfig({ defaultPreset: "missing" }).defaultPreset, "normal");

const lists = normalizeConfig({
    bosses: [{ id: " Ranrak ", baseHp: -5 }, { id: "" }, { baseHp: 100 }, "Troll"],
    groups: [["Goblin", "Goblins"], ["Wolf"], [1, "Beasts"]],
    hidden: ["Mandrake", 7],
});
assert.deepStrictEqual(lists.bosses, [{ id: "Ranrak", baseHp: 1 }]);
assert.deepStrictEqual(lists.groups, [["Goblin", "Goblins"]]);
assert.deepStrictEqual(lists.hidden, ["Mandrake"]);

const altar = normalizeConfig({
    interaction: { enabled: true, position: { x: 10, y: "y" }, areaId: "Overland", label: "  ", object: { scale: 2 } },
}).interaction;
assert.strictEqual(altar.enabled, true);
assert.deepStrictEqual(altar.position, { x: 10, y: 0, z: 0 });
assert.strictEqual(altar.areaId, "Overland");
assert.strictEqual(altar.label, DEFAULT_CONFIG.interaction.label);
assert.deepStrictEqual(altar.object, { model: DEFAULT_CONFIG.interaction.object!.model, pitch: 0, yaw: 0, roll: 0, scale: 2, collision: true });
assert.deepStrictEqual(normalizeConfig({ interaction: {} }).interaction.object, DEFAULT_CONFIG.interaction.object);

console.log("hmp-gauntlet config tests passed");
