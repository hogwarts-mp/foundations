const assert = require("node:assert");
const path = require("node:path");

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const serverExports = new Map();
const serverHandlers = new Map();
const playerEvents = [];
const player = { id: 1, nickname: "Smoke", connected: true, emit: (name, payload) => playerEvents.push({ name, payload }) };
let environment = { weather: "Default_PHY", hour: 12, minute: 0, second: 0, day: 1, month: 1, year: 0, season: 0, timeScale: 1, revision: 0 };
global.Exports = { register: (name, value) => serverExports.set(name, value) };
global.Imports = { get: (name) => {
    if (name !== "hmp-lib") throw new Error(`Unexpected import ${name}`);
    return {
        logger: { create: () => logger },
        config: { load: (_file, options) => options.defaults },
    };
} };
global.PlayerManager = { getAll: () => [player] };
global.Events = {
    on: (name, handler) => serverHandlers.set(name, handler),
    onClient: (name, handler) => serverHandlers.set(`client:${name}`, handler),
    emitAllClients() {},
};
global.World = {
    get weather() { return environment.weather; },
    get hour() { return environment.hour; },
    get minute() { return environment.minute; },
    get second() { return environment.second; },
    get day() { return environment.day; },
    get month() { return environment.month; },
    get year() { return environment.year; },
    get season() { return environment.season; },
    get timeScale() { return environment.timeScale; },
    get revision() { return environment.revision; },
    setWeather: (weather) => { environment.weather = weather; environment.revision++; return true; },
    setTime: (hour, minute, second = 0) => { Object.assign(environment, { hour, minute, second }); environment.revision++; return true; },
    setDate: (day, month, year = 0) => { Object.assign(environment, { day, month, year }); environment.revision++; return true; },
    setSeason: (season) => { environment.season = season; environment.revision++; return true; },
    setTimeScale: (timeScale) => { environment.timeScale = timeScale; environment.revision++; return true; },
};
require(path.resolve(__dirname, "..", "dist", "server.js"));
assert.deepStrictEqual([...serverExports.keys()], ["environment", "policy", "status"]);
assert.ok(serverHandlers.has("client:hmp-world:ready"));
assert.ok(serverHandlers.has("worldReady"));
assert.strictEqual(serverExports.get("policy").current().removeBoundaryVolumes, true);
serverHandlers.get("client:hmp-world:ready")(player);
assert.strictEqual(playerEvents[0].name, "hmp-world:policy");

const clientExports = new Map();
const clientHandlers = new Map();
const clientEmits = [];
const worldCalls = [];
global.Exports = { register: (name, value) => clientExports.set(name, value) };
global.Imports = { get: () => ({ logger: { create: () => logger } }) };
global.Events = {
    on: (name, handler) => clientHandlers.set(name, handler),
    emitServer: (name, payload) => clientEmits.push({ name, payload }),
};
global.World = {
    setBoundaryPolicy: (value) => { worldCalls.push(["boundaries", value]); return 1; },
    setAmbientPopulation: (value) => { worldCalls.push(["population", value]); return true; },
    setEncounterPolicy: (value) => { worldCalls.push(["encounters", value]); return 1; },
};
require(path.resolve(__dirname, "..", "dist", "client.js"));
assert.deepStrictEqual([...clientExports.keys()], ["policy", "status"]);
assert.deepStrictEqual(clientEmits.map((entry) => entry.name), ["hmp-world:ready"]);
assert.ok(clientHandlers.has("hmp-world:policy"));
clientHandlers.get("hmp-world:policy")({ removeBoundaryVolumes: true, ambientPopulation: false, nativeEncounters: false });
assert.deepStrictEqual(worldCalls, [["boundaries", true], ["population", false], ["encounters", true]]);
assert.strictEqual(clientExports.get("policy").restore(), true);
clientHandlers.get("resourceStop")("hmp-world");
console.log("hmp-world bundle contract passed");
