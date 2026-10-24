const assert = require("node:assert");
const path = require("node:path");

const serverExports = new Map();
const serverHandlers = new Map();
const warnings = [];
const logger = { info() {}, warn: (message) => warnings.push(message), error() {}, debug() {} };
const lockRule = { priority: 100, action: "lock", doors: ["BP_Smoke_Door"], lockLevel: 2 };
const replies = [];
const player = { id: 1, nickname: "Smoke", emit() {}, sendChat: (message) => replies.push(message) };
const core = {
    sessions: { isReady: () => true },
    characters: { active: () => null },
    groups: { effective: async () => [], has: async () => true },
    metadata: { getCharacter: async () => [], setCharacter: async (_id, _key, value) => value },
};
global.Exports = { register: (name, value) => serverExports.set(name, value) };
global.Imports = { get: (name) => {
    if (name === "hmp-lib") return {
        logger: { create: () => logger },
        config: {
            load: (_path, options) => ({ ...options.defaults, heldGates: { BP_Smoke_Gate: { open: true } }, rules: [...options.defaults.rules, lockRule] }),
            env: { boolean: (_value, fallback) => fallback },
        },
        player: { find: () => player },
    };
    if (name === "hmp-core") return core;
    throw new Error(`Unexpected import ${name}`);
} };
global.PlayerManager = { getAll: () => [player] };
global.Events = {
    on: (name, handler) => serverHandlers.set(name, handler),
    onClient: (name, handler) => serverHandlers.set(`client:${name}`, handler),
};

// The command answers once the admin check settles.
async function command(...args) {
    replies.length = 0;
    serverHandlers.get("chatCommand")(player, "", "doors", args);
    await new Promise((resolve) => setImmediate(resolve));
    return replies.at(-1);
}

void (async () => {
    const serverBundle = path.resolve(__dirname, "..", "dist", "server.js");
    // A host without the server Doors and Gates builtins still starts, lock-level rule, held gate and all.
    require(serverBundle);
    assert.deepStrictEqual([...serverExports.keys()], ["policy", "grants", "status"]);
    assert.ok(serverHandlers.has("client:hmp-doors:ready"));
    assert.ok(serverHandlers.has("hmp:groups:changed"));
    assert.strictEqual(warnings.length, 2);
    assert.match(await command("gateset", "open", "BP_Smoke_Gate"), /needs a HogwartsMP host with the server Gates builtin/);

    // A newer host gets the rule's level, unlocks kept private and the held gate at start, each given back at stop.
    const held = [];
    const levels = new Map();
    const shares = [];
    global.Doors = {
        set: (selector, state) => { held.push([selector, state]); if (state.lockLevel) levels.set(selector, state.lockLevel); else levels.delete(selector); return true; },
        get: (selector) => levels.has(selector) ? { selector, kind: "name", locked: null, open: null, lockLevel: levels.get(selector) } : null,
        getShareUnlocks: () => true,
        setShareUnlocks: (share) => shares.push(share),
    };
    const gateSets = [];
    const gates = new Map();
    global.Gates = {
        set: (selector, state) => {
            gateSets.push([selector, state]);
            const next = { ...gates.get(selector) };
            for (const axis of ["locked", "open"]) {
                if (state[axis] === null) delete next[axis];
                else if (state[axis] !== undefined) next[axis] = state[axis];
            }
            if (Object.keys(next).length) gates.set(selector, next);
            else gates.delete(selector);
            return true;
        },
        get: (selector) => gates.has(selector) ? { selector, kind: "name", locked: gates.get(selector).locked ?? null, open: gates.get(selector).open ?? null } : null,
        list: () => [...gates.keys()].map((selector) => global.Gates.get(selector)),
    };
    delete require.cache[serverBundle];
    require(serverBundle);
    assert.deepStrictEqual(held, [["BP_Smoke_Door", { lockLevel: 2 }]]);
    assert.deepStrictEqual(shares, [false]);
    assert.deepStrictEqual(gateSets, [["BP_Smoke_Gate", { open: true }]]);
    assert.strictEqual(await command("gateset", "locked", "BP_Smoke_Gate"), "[doors] held for everyone: BP_Smoke_Gate [name] locked=true open=true");
    assert.strictEqual(await command("gatesheld"), "[doors] 1 gate(s) held: BP_Smoke_Gate [name] locked=true open=true");
    assert.match(await command("gateset", "ajar", "BP_Smoke_Gate"), /Usage: \/doors gateset <locked\|unlocked\|open\|closed\|release>/);
    serverHandlers.get("resourceStop")("hmp-doors");
    assert.deepStrictEqual(held.at(-1), ["BP_Smoke_Door", { lockLevel: null }]);
    assert.deepStrictEqual(shares, [false, true]);
    // Only the config's own axis is let go; the lock an admin held stays.
    assert.deepStrictEqual(gateSets.at(-1), ["BP_Smoke_Gate", { open: null }]);
    assert.deepStrictEqual(gates.get("BP_Smoke_Gate"), { locked: true });
    assert.strictEqual(warnings.length, 2);

    const clientExports = new Map();
    const clientHandlers = new Map();
    const clientEmits = [];
    global.Exports = { register: (name, value) => clientExports.set(name, value) };
    global.Events = {
        on: (name, handler) => clientHandlers.set(name, handler),
        emitServer: (name, payload) => clientEmits.push({ name, payload }),
    };
    global.Doors = {
        setLock: () => true, superAlohomora: () => true, openNearby: () => 0,
        list: () => [{ name: "BP_Smoke_Door", cls: "Door", dist: 250, bearing: 0, lockLevel: 2 }],
        unlockNearby: () => 0, setOpen: () => true, setPolicy() {}, setLocked: () => 1,
    };
    const gatePolicies = [];
    global.Gates = {
        setPolicy: (policy) => { gatePolicies.push(policy); return 0; },
        list: () => [{ name: "BP_Smoke_Gate", cls: "BP_Portcullis_C", path: "", kind: "portcullis", dist: 400, bearing: 0, isOpen: false, isLocked: false }],
        setOpen: () => 1, setLocked: () => 1,
    };
    const notices = [];
    global.Game = { notify: (message) => notices.push(message) };
    const prompts = [];
    global.Hud = { showPrompt: (...args) => prompts.push(args), hidePrompt() {} };
    global.LocalPlayer = {
        getPosition: () => ({ x: 0, y: 0, z: 0 }),
        getRotation: () => ({ pitch: 0, yaw: 0, roll: 0 }),
    };
    require(path.resolve(__dirname, "..", "dist", "client.js"));
    assert.deepStrictEqual([...clientExports.keys()], ["status", "list", "labels"]);
    assert.ok(clientHandlers.has("hmp-doors:policy"));
    assert.deepStrictEqual(clientEmits.map((event) => event.name), ["hmp-doors:ready"]);
    clientHandlers.get("hmp-doors:policy")({ unlockAll: true, unlockGateKinds: ["portcullis"], lockGates: ["BP_Vault_Gate"] });
    assert.deepStrictEqual(gatePolicies, [{ unlockAll: ["portcullis"], openAll: [], freezeSchedule: false, unlockGates: [], openGates: [], allExcept: [], lockGates: ["BP_Vault_Gate"] }]);
    clientHandlers.get("hmp-doors:diagnostic")(JSON.stringify({ action: "list" }));
    assert.ok(notices.includes("250cm BP_Smoke_Door [Door] Lv.2"));
    clientHandlers.get("hmp-doors:diagnostic")(JSON.stringify({ action: "gates" }));
    assert.ok(notices.includes("400cm BP_Smoke_Gate [portcullis, shut]"));
    clientHandlers.get("hmp-doors:diagnostic")(JSON.stringify({ action: "label" }));
    assert.deepStrictEqual(prompts, [["2.5m", "BP_Smoke_Door", 250, 0, 120]]);
    assert.strictEqual(clientHandlers.get("hmp-doors:diagnostic")(JSON.stringify({ action: "label-off" })), true);
    clientHandlers.get("resourceStop")("hmp-doors");
    assert.deepStrictEqual(gatePolicies.at(-1), {});
    console.log("hmp-doors bundle contract passed");
})().catch((error) => { console.error(error); process.exit(1); });
