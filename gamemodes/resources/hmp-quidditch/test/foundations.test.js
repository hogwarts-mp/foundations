const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const server = fs.readFileSync(path.join(root, "server", "main.js"), "utf8");
const client = fs.readFileSync(path.join(root, "client", "main.js"), "utf8");
const dependencies = new Set(manifest.mafiahub.resourceDependencies.map((entry) => entry.name));

assert.strictEqual(manifest.name, "hmp-quidditch");
for (const name of ["hmp-lib", "hmp-core", "hmp-activities", "hmp-ui", "hmp-houses", "hmp-inventory", "hmp-interact", "hmp-audio", "hmp-blips", "hmp-world"]) {
    assert.ok(dependencies.has(name), `missing ${name} dependency`);
    assert.ok(server.includes(`Imports.get("${name}")`) || client.includes(`Imports.get("${name}")`), `${name} is declared but not imported`);
}
assert.ok(server.includes("Core.metadata.setCharacter"), "career totals must be character-scoped");
assert.ok(server.includes("Activities.sessions"), "match lifecycle must use hmp-activities");
assert.ok(server.includes("FoundationAudio.sounds"), "audio must use hmp-audio");
assert.ok(server.includes("FoundationBlips.markers"), "markers must use hmp-blips");
assert.ok(client.includes("Hmp.input.shortcuts.register"), "shortcuts must use hmp-lib arbitration");
assert.ok(client.includes("FoundationWorld.policy.restore"), "world policy must restore through hmp-world");
assert.ok(server.includes("FoundationWorld.policy.set"), "native encounters must be suppressed through hmp-world");
assert.ok(server.includes("Core.groups.has"), "match control must check hmp-core groups");
assert.ok(!manifest.mafiahub.resourceDependencies.some((entry) => ["rp-ui", "interactables"].includes(entry.name)));
// The pitch is server WorldObjects: no client builtin and no client reporting where things are.
for (const [side, source] of [["server", server], ["client", client]]) {
    assert.doesNotMatch(source, /\bQuidditch\.\w+\(/, `${side} still calls the removed client Quidditch builtin`);
    assert.doesNotMatch(source, /quidditch:(ballAt|snitchAt)/, `${side} still trusts a client position report`);
}
assert.ok(server.includes("WorldObject.create"), "the pitch must be built from server WorldObjects");
console.log("hmp-quidditch Foundations integration contract passed");
