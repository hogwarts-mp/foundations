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
    policy: { removeBoundaryVolumes: true, ambientPopulation: false },
});
assert.strictEqual(config.environment.season, "autumn");
assert.strictEqual(config.policy.encounters, "suppressed");
assert.strictEqual(config.policy.playerCollision, false);
assert.strictEqual(config.policy.fastTravel, true);
assert.throws(() => normalizeConfig({ ...config, policy: { ...config.policy, fastTravel: "no" } }), /fastTravel must be a boolean/);
assert.strictEqual(normalizeConfig({ ...config, policy: { ...config.policy, encounters: "server" } }).policy.encounters, "server");
assert.throws(() => normalizeConfig({ ...config, policy: { ...config.policy, encounters: "native" } }), /"suppressed" or "server"/);
assert.throws(() => normalizeConfig({ ...config, policy: { ...config.policy, removeBoundaryVolumes: "yes" } }), /boolean/);
assert.throws(() => normalizeConfig({ ...config, policy: { ...config.policy, playerCollision: "yes" } }), /playerCollision must be a boolean/);
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
    setEncounterPolicy(policy: string) { nativeCalls.push(["encounters", policy]); return true; },
    setPlayerCollision(on: boolean) { nativeCalls.push(["collision", on]); return true; },
};
const players = [{ id: 4, nickname: "Tester", connected: true, emitted: [] as unknown[], emit(name: string, payload?: unknown) { this.emitted.push({ name, payload }); } }];
const broadcasts: Array<{ name: string; payload: unknown }> = [];
const service = createWorldService({ config, native, players: () => players, events: { emitAllClients: (name, payload) => broadcasts.push({ name, payload }) } });
assert.deepStrictEqual(nativeCalls.map(([name]) => name), ["scale", "weather", "date", "season", "time", "scale", "encounters", "collision"]);
assert.deepStrictEqual(nativeCalls.slice(-2), [["encounters", "suppressed"], ["collision", false]]);
assert.strictEqual(service.environment.state()?.weather, "Clear");
assert.strictEqual(service.environment.state()?.season, 2);
assert.strictEqual(service.policy.sync(players[0]), 1);
assert.strictEqual(players[0].emitted.length, 1);
// Clients apply only what they own; encounters stay on the server.
assert.deepStrictEqual(JSON.parse(String((players[0].emitted[0] as { payload: unknown }).payload)), { contract: "hmp.world.policy/v2", removeBoundaryVolumes: true, ambientPopulation: false });
service.policy.set({ encounters: "server" });
assert.strictEqual(service.policy.current().encounters, "server");
assert.deepStrictEqual(nativeCalls.at(-1), ["encounters", "server"]);
assert.strictEqual(broadcasts.length, 1);
assert.throws(() => service.policy.set({ encounters: "native" as never }), /"suppressed" or "server"/);
const encounterCalls = () => nativeCalls.filter(([name]) => name === "encounters").length;
const encountersBefore = encounterCalls();
service.policy.set({ removeBoundaryVolumes: false });
assert.strictEqual(encounterCalls(), encountersBefore);
service.policy.reset();
assert.strictEqual(service.policy.current().encounters, "suppressed");
assert.deepStrictEqual(nativeCalls.at(-1), ["encounters", "suppressed"]);
assert.strictEqual(broadcasts.length, 3);
service.policy.set({ playerCollision: true });
assert.deepStrictEqual(nativeCalls.at(-1), ["collision", true]);
// The host applies player collision for every client, like encounters.
assert.ok(!("playerCollision" in JSON.parse(String(broadcasts.at(-1)?.payload))));
assert.throws(() => service.policy.set({ playerCollision: "yes" as never }), /playerCollision must be a boolean/);
service.policy.reset();
assert.deepStrictEqual(nativeCalls.at(-1), ["collision", false]);
service.environment.setSeason("winter");
assert.strictEqual(environmentState.season, 3);

// A host without World.setPlayerCollision still starts and keeps the policy; players walk through each other.
const callsBeforeOlderHost = nativeCalls.length;
const olderHost = createWorldService({
    config: normalizeConfig({ ...config, policy: { ...config.policy, playerCollision: true } }),
    native: Object.create(native, { setPlayerCollision: { value: undefined } }),
    players: () => players,
    events: { emitAllClients: () => {} },
});
assert.strictEqual(olderHost.policy.current().playerCollision, true);
assert.strictEqual(olderHost.policy.set({ playerCollision: false }).playerCollision, false);
assert.ok(!nativeCalls.slice(callsBeforeOlderHost).some(([name]) => name === "collision"));
olderHost.stop();

// Fast travel is held per connection, and a connection starts allowed, so only a refusal is sent on connect.
const travellers = [
    { id: 7, nickname: "Floo", connected: true, fastTravel: [] as boolean[], emit() {}, setFastTravelEnabled(on: boolean) { this.fastTravel.push(on); } },
    { id: 8, nickname: "OlderHost", connected: true, emit() {} },
    { id: 9, nickname: "Leaving", connected: true, emit() {}, setFastTravelEnabled() { throw new Error("Player is not connected"); } },
];
const traveller = travellers[0];
const travel = createWorldService({
    config: normalizeConfig({ ...config, policy: { ...config.policy, fastTravel: false } }),
    native,
    players: () => travellers,
    events: { emitAllClients: () => {} },
});
assert.deepStrictEqual(traveller.fastTravel, [false], "players already online when the resource starts are switched off");
travel.connect(traveller);
assert.deepStrictEqual(traveller.fastTravel, [false, false]);
travel.policy.set({ fastTravel: true });
assert.deepStrictEqual(traveller.fastTravel, [false, false, true]);
travel.connect(traveller);
travel.policy.set({ ambientPopulation: true });
assert.deepStrictEqual(traveller.fastTravel, [false, false, true], "an allowed connection and other policy changes send nothing");
assert.throws(() => travel.policy.set({ fastTravel: "no" as never }), /fastTravel must be a boolean/);
travel.policy.reset();
assert.deepStrictEqual(traveller.fastTravel.at(-1), false);
travel.stop();
assert.deepStrictEqual(traveller.fastTravel.at(-1), true, "stopping gives online players their fast travel back");
travel.connect(traveller);
assert.deepStrictEqual(traveller.fastTravel.length, 5);

assert.strictEqual(parsePolicy("bad"), null);
assert.deepStrictEqual(parsePolicy(JSON.stringify(config.policy)), { removeBoundaryVolumes: true, ambientPopulation: false });
const clientCalls: Array<[string, unknown]> = [];
let ready = 0;
const client = createWorldClient({
    emitReady: () => { ready++; },
    native: {
        setBoundaryPolicy: (value) => { clientCalls.push(["boundaries", value]); return 12; },
        setAmbientPopulation: (value) => { clientCalls.push(["population", value]); return true; },
    },
});
assert.strictEqual(ready, 1);
assert.strictEqual(client.apply(config.policy), true);
assert.deepStrictEqual(clientCalls, [["boundaries", true], ["population", false]]);
assert.strictEqual(client.status().boundaryVolumesChanged, 12);
assert.deepStrictEqual(client.policy.current(), { removeBoundaryVolumes: true, ambientPopulation: false });
assert.strictEqual(client.policy.restore(), true);
assert.strictEqual(clientCalls.length, 4);
client.stop();
assert.strictEqual(client.policy.restore(), false);
assert.strictEqual(client.apply(config.policy), false);
service.stop();

console.log("hmp-world tests passed");
