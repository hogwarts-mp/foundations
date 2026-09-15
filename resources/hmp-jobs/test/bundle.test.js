const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const bundle = path.join(__dirname, "..", "dist", "server.js");
assert.ok(fs.existsSync(bundle), "server bundle is missing");
const source = fs.readFileSync(bundle, "utf8");
assert.ok(source.includes("hmp:jobs:hired"), "server bundle does not contain the jobs service");
assert.ok(source.includes("Exports.register"), "server bundle does not register exports");
const clientSource = fs.readFileSync(path.resolve(__dirname, "..", "dist", "client.js"), "utf8");
assert.ok(clientSource.includes("client dependency shim ready"));
console.log("hmp-jobs bundle smoke test passed");
