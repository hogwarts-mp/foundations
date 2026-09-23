import assert = require("node:assert");
import configModule = require("../server/config");
import serviceModule = require("../server/service");
import clientModule = require("../client/service");

const { normalizeConfig } = configModule;
const { createWorldService } = serviceModule;
const { createWorldClient, parsePolicy } = clientModule;

const config = normalizeConfig({
    environment: {
        weather: "Clear",
        time: { hour: 9, minute: 15, second: 30, scale: 2 },
        date: { day: 1, month: 9, year: 0 },
        season: "autumn",
    },
    policy: { removeBoundaryVolumes: true, ambientPopulation: false, nativeEncounters: false },
});
assert.strictEqual(config.environment.season, "autumn");
assert.throws(() => normalizeConfig({ ...config, policy: { ...config.policy, removeBoundaryVolumes: "yes" } }), /boolean/);
assert.throws(() => normalizeConfig({ ...config, environment: { ...config.environment, time: { ...config.environment.time, hour: 24 } } }), /0 to 23/);

const nativeCalls: Array<[string, ...unknown[]]> = [];
let environmentState = {
    weather: "Default_PHY", hour: 12, minute: 0, second: 0, day: 1, month: 1, year: 0,
    season: 0 as 0 | 1 | 2 | 3, timeScale: 1, revision: 0,
};
const native = {
    get weather() { return environmentState.weather; },
    get hour() { return environmentState.hour; },
    get minute() { return environmentState.minute; },
    get second() { return environmentState.second; },
    get day() { return environmentState.day; },
    get month() { return environmentState.month; },
    get year() { return environmentState.year; },
    get season() { return environmentState.season; },
    get timeScale() { return environmentState.timeScale; },
    get revision() { return environmentState.revision; },
    setWeather(value: string) { nativeCalls.push(["weather", value]); environmentState.weather = value; environmentState.revision++; return true; },
    setTime(hour: number, minute: number, second = 0) { nativeCalls.push(["time", hour, minute, second]); Object.assign(environmentState, { hour, minute, second }); environmentState.revision++; return true; },
    setDate(day: number, month: number, year = 0) { nativeCalls.push(["date", day, month, year]); Object.assign(environmentState, { day, month, year }); environmentState.revision++; return true; },
    setSeason(season: number) { nativeCalls.push(["season", season]); environmentState.season = season as 0 | 1 | 2 | 3; environmentState.revision++; return true; },
    setTimeScale(scale: number) { nativeCalls.push(["scale", scale]); environmentState.timeScale = scale; environmentState.revision++; return true; },
};
const players = [{ id: 4, nickname: "Tester", connected: true, emitted: [] as unknown[], emit(name: string, payload?: unknown) { this.emitted.push({ name, payload }); } }];
const broadcasts: Array<{ name: string; payload: unknown }> = [];
const service = createWorldService({ config, native, players: () => players, events: { emitAllClients: (name, payload) => broadcasts.push({ name, payload }) } });
assert.deepStrictEqual(nativeCalls.map(([name]) => name), ["scale", "weather", "date", "season", "time", "scale"]);
assert.strictEqual(service.environment.state()?.weather, "Clear");
assert.strictEqual(service.environment.state()?.season, 2);
assert.strictEqual(service.policy.sync(players[0]), 1);
assert.strictEqual(players[0].emitted.length, 1);
service.policy.set({ nativeEncounters: true });
assert.strictEqual(service.policy.current().nativeEncounters, true);
assert.strictEqual(broadcasts.length, 1);
service.policy.reset();
assert.strictEqual(service.policy.current().nativeEncounters, false);
assert.strictEqual(broadcasts.length, 2);
service.environment.setSeason("winter");
assert.strictEqual(environmentState.season, 3);

assert.strictEqual(parsePolicy("bad"), null);
assert.deepStrictEqual(parsePolicy(JSON.stringify(config.policy)), config.policy);
const clientCalls: Array<[string, unknown]> = [];
let ready = 0;
const client = createWorldClient({
    emitReady: () => { ready++; },
    native: {
        setBoundaryPolicy: (value) => { clientCalls.push(["boundaries", value]); return 12; },
        setAmbientPopulation: (value) => { clientCalls.push(["population", value]); return true; },
        setEncounterPolicy: (value) => { clientCalls.push(["encounters", value]); return 8; },
    },
});
assert.strictEqual(ready, 1);
assert.strictEqual(client.apply(config.policy), true);
assert.deepStrictEqual(clientCalls, [["boundaries", true], ["population", false], ["encounters", true]]);
assert.strictEqual(client.status().boundaryVolumesChanged, 12);
assert.strictEqual(client.policy.restore(), true);
assert.strictEqual(clientCalls.length, 6);
client.stop();
assert.strictEqual(client.policy.restore(), false);
assert.strictEqual(client.apply(config.policy), false);
service.stop();

console.log("hmp-world tests passed");
