import assert = require("node:assert");
import configModule = require("../server/config");
import serviceModule = require("../server/service");
import type { ExpressClock, ExpressConfig } from "../server/internal";

const { loadConfig, normalizeConfig } = configModule;
const { createExpressService } = serviceModule;

type TrainState = ReturnType<HogwartsMpHogwartsExpress["get"]>;
const ABSENT: TrainState = { spawned: false, moving: false, departing: false, t: 0, speed: 0, target: null, seconds: null };

// The host's train, with the events its next tick would send kept until flush().
function fakeTrain(stops = [{ id: "hogsmeade", t: 0.31 }]) {
    let train: TrainState = { ...ABSENT };
    const calls: string[] = [];
    const queued: Array<"stopped" | "ended"> = [];
    const where = (at: number | string) => typeof at === "number" ? at : stops.find((stop) => stop.id === at)?.t;
    const native: HogwartsMpHogwartsExpress = {
        length: 2896,
        stops,
        spawn(at = 0) {
            const t = where(at);
            if (t === undefined) return false;
            calls.push(`spawn ${at}`);
            if (train.spawned) queued.push("ended");
            train = { ...ABSENT, spawned: true, t };
            return true;
        },
        moveTo(at, options) {
            const t = where(at);
            if (!train.spawned || train.departing || t === undefined || t < train.t) return false;
            calls.push(`moveTo ${at} ${JSON.stringify(options || {})}`);
            train = { ...train, moving: true, target: t, seconds: 60 };
            return true;
        },
        depart(options) {
            if (!train.spawned || train.departing) return false;
            calls.push(`depart ${JSON.stringify(options || {})}`);
            train = { ...train, moving: true, departing: true, target: null, seconds: 90 };
            return true;
        },
        halt() {
            if (!train.moving || train.departing) return false;
            calls.push("halt");
            train = { ...train, moving: false, target: null, seconds: null };
            queued.push("stopped");
            return true;
        },
        despawn() {
            if (!train.spawned) return false;
            calls.push("despawn");
            train = { ...ABSENT };
            queued.push("ended");
            return true;
        },
        get: () => ({ ...train }),
    };
    return {
        native,
        calls,
        // The leg runs out: a moveTo stands on its spot, a departure leaves the track.
        arrive() {
            if (train.departing) { train = { ...ABSENT }; queued.push("ended"); }
            else if (train.moving) { train = { ...train, moving: false, t: train.target!, target: null, seconds: null }; queued.push("stopped"); }
        },
        flush(service: { stopped(): void; ended(): void }) {
            for (const event of queued.splice(0)) event === "stopped" ? service.stopped() : service.ended();
        },
    };
}

// The defaults as written, before normalization.
let rawDefaults: Record<string, unknown> = {};
const base: ExpressConfig = loadConfig({
    config: { load: (_path: string, options: { defaults: Record<string, unknown> }) => (rawDefaults = options.defaults) },
} as never, { env: {} as NodeJS.ProcessEnv });

function harness(overrides: Record<string, unknown> = {}, native: ReturnType<typeof fakeTrain> | null = fakeTrain()) {
    // Monday 7 September 1891, 09:59; World.year 0 keeps the game's own year.
    const clock: ExpressClock = { hour: 9, minute: 59, day: 7, month: 9, year: 0, timeScale: 1 };
    const timers: Array<{ handler: () => void; ms: number; cleared: boolean }> = [];
    const intervals: Array<{ handler: () => void; ms: number; cleared: boolean }> = [];
    const logs: string[] = [];
    let time = 1_000_000;
    const config = normalizeConfig({ ...rawDefaults, ...overrides });
    const service = createExpressService({
        config,
        native: native?.native ?? null,
        clock: () => ({ ...clock }),
        logger: { info: (message: unknown) => { logs.push(String(message)); return true; }, warn: (message: unknown) => { logs.push(String(message)); return true; } },
        now: () => time,
        setTimer: (handler, ms) => { timers.push({ handler, ms, cleared: false }); return timers.length as unknown as ReturnType<typeof setTimeout>; },
        clearTimer: (timer) => { timers[(timer as unknown as number) - 1].cleared = true; },
        setInterval: (handler, ms) => { intervals.push({ handler, ms, cleared: false }); return intervals.length as unknown as ReturnType<typeof setInterval>; },
        clearInterval: (timer) => { intervals[(timer as unknown as number) - 1].cleared = true; },
    });
    const at = (hour: number, minute: number, day = clock.day) => {
        Object.assign(clock, { hour, minute, day });
        for (const interval of intervals) if (!interval.cleared) interval.handler();
    };
    const fire = () => {
        const timer = timers.find((entry) => !entry.cleared);
        assert.ok(timer, "a timer is pending");
        timer.cleared = true;
        timer.handler();
    };
    return { service, clock, timers, intervals, logs, at, fire, advance: (ms: number) => { time += ms; } };
}

// Config: the defaults are the game's own timetable, driven straight through.
assert.strictEqual(base.enabled, true);
assert.deepStrictEqual(base.departures, [{ time: "10:00", minute: 600, days: [1, 3, 5] }, { time: "21:00", minute: 1260, days: [6] }]);
assert.deepStrictEqual(base.stops, []);
assert.deepStrictEqual([base.speed, base.accel, base.decel, base.year], [20, 0.5, 0.7, 1891]);
const raw = (patch: Record<string, unknown>) => ({ enabled: true, departures: [], stops: [], speed: 20, accel: 0.5, decel: 0.7, year: 1891, ...patch });
const parsed = normalizeConfig(raw({ departures: [{ time: "7:05" }, { time: "18:30", days: ["Sunday", "sunday", "friday"] }], stops: [{ at: "hogsmeade" }, { at: 1, dwellSeconds: 0 }] }));
assert.deepStrictEqual(parsed.departures, [{ time: "07:05", minute: 425, days: [0, 1, 2, 3, 4, 5, 6] }, { time: "18:30", minute: 1110, days: [0, 5] }]);
assert.deepStrictEqual(parsed.stops, [{ at: "hogsmeade", dwellSeconds: 120 }, { at: 1, dwellSeconds: 0 }]);
const bad = (patch: Record<string, unknown>, pattern: RegExp) => assert.throws(() => normalizeConfig(raw(patch)), pattern);
bad({ enabled: "yes" }, /enabled must be a boolean/);
bad({ departures: [{ time: "24:00" }] }, /time must be "HH:MM"/);
bad({ departures: [{ time: "10:00", days: ["funday"] }] }, /not a weekday name/);
bad({ departures: [{ time: "10:00", days: [] }] }, /non-empty array/);
bad({ stops: [{ at: "hogsmeade station" }] }, /stop id/);
bad({ stops: [{ at: 1.5 }] }, /a t from 0 to 1/);
bad({ stops: [{ at: "hogsmeade", dwellSeconds: 3601 }] }, /dwellSeconds must be an integer from 0 to 3600/);
bad({ speed: 61 }, /speed must be a number above 0 and at most 60/);
bad({ decel: 0 }, /decel must be a number above 0/);
bad({ year: 0 }, /year must be an integer/);

{
    // Straight through: Monday 10:00 spawns the train at the start and sends it off the far end.
    const train = fakeTrain();
    const { service, intervals, at, logs } = harness({}, train);
    assert.strictEqual(service.status().state, "ready");
    assert.deepStrictEqual(intervals.map((entry) => entry.ms), [1000]);
    at(9, 59);
    assert.deepStrictEqual(train.calls, []);
    at(10, 0);
    assert.deepStrictEqual(train.calls, ["spawn 0", 'depart {"speed":20,"accel":0.5,"decel":0.7}']);
    assert.deepStrictEqual(service.status().run, { departure: "10:00", stop: null, leavesAt: null });
    assert.ok(logs.includes("10:00 departure"));
    at(10, 1);
    assert.strictEqual(train.calls.length, 2, "a minute later is no new departure");
    train.arrive();
    train.flush(service);
    assert.strictEqual(service.status().run, null);
    assert.strictEqual(service.status().train?.spawned, false);
    // Tuesday has no departure.
    at(9, 59, 8);
    at(10, 0, 8);
    assert.strictEqual(train.calls.length, 2);
}

{
    // A stop: the train pulls in, stands dwellSeconds real seconds, then leaves for the far end.
    const train = fakeTrain();
    const { service, at, timers, fire, advance } = harness({ stops: [{ at: "hogsmeade", dwellSeconds: 60 }] }, train);
    at(10, 0);
    assert.deepStrictEqual(train.calls, ["spawn 0", 'moveTo hogsmeade {"speed":20,"accel":0.5,"decel":0.7}']);
    assert.deepStrictEqual(service.status().run, { departure: "10:00", stop: "hogsmeade", leavesAt: null });
    advance(5000);
    train.arrive();
    train.flush(service);
    assert.deepStrictEqual(timers.map((entry) => entry.ms), [60000]);
    assert.deepStrictEqual(service.status().run, { departure: "10:00", stop: "hogsmeade", leavesAt: 1_065_000 });
    // A second trainStopped while it stands does not start a second dwell.
    service.stopped();
    assert.strictEqual(timers.length, 1);
    fire();
    assert.strictEqual(train.calls.at(-1), 'depart {"speed":20,"accel":0.5,"decel":0.7}');
    assert.deepStrictEqual(service.status().run, { departure: "10:00", stop: null, leavesAt: null });
    // A departure while the train is still out is skipped rather than replacing it.
    at(9, 59, 9);
    at(10, 0, 9);
    assert.strictEqual(train.calls.filter((call) => call.startsWith("spawn")).length, 1);
    train.arrive();
    train.flush(service);
    assert.strictEqual(service.status().run, null);
}

{
    // A clock set forward past an hour skips the departures in between; a fast clock may step further.
    const train = fakeTrain();
    const { at, clock } = harness({}, train);
    at(11, 30);
    assert.deepStrictEqual(train.calls, []);
    at(9, 0, 9);
    clock.timeScale = 60;
    at(10, 30, 9);
    assert.deepStrictEqual(train.calls.slice(0, 1), ["spawn 0"], "three seconds of a 60x clock cover 90 minutes");
}

{
    // The exports: run() follows the route now; a drive call takes the train off it.
    const train = fakeTrain();
    const { service, timers, fire } = harness({ departures: [], stops: [{ at: "hogsmeade", dwellSeconds: 30 }] }, train);
    assert.deepStrictEqual(service.train.stops(), [{ id: "hogsmeade", t: 0.31 }]);
    assert.strictEqual(service.train.run(), true);
    assert.strictEqual(service.train.run(), false, "only one train runs at a time");
    train.arrive();
    train.flush(service);
    assert.strictEqual(service.status().run?.departure, null);
    assert.strictEqual(service.train.halt(), false, "a standing train cannot halt, and the run goes on");
    assert.ok(service.status().run);
    assert.strictEqual(service.train.moveTo(0.9, { speed: 10 }), true);
    assert.strictEqual(service.status().run, null);
    assert.strictEqual(timers[0].cleared, true, "the dwell ended with the run");
    assert.throws(() => fire(), /a timer is pending/);
    // A spawn replacing the train ends it on the host; that trainEnded is not the new train's.
    assert.strictEqual(service.train.spawn(), true);
    train.flush(service);
    assert.strictEqual(service.train.get()?.spawned, true);
    service.stop();
    assert.strictEqual(train.calls.at(-1), "despawn", "stopping removes the resource's train");
    assert.strictEqual(service.status().state, "stopped");
    assert.strictEqual(service.train.run(), false);
}

{
    // A train another script spawned stays when the resource stops.
    const train = fakeTrain();
    const { service } = harness({}, train);
    train.native.spawn(0.5);
    service.stop();
    assert.deepStrictEqual(train.calls, ["spawn 0.5"]);
}

{
    // A route this host cannot run degrades instead of failing at a departure.
    const unknown = harness({ stops: [{ at: "kings-cross" }] }).service.status();
    assert.strictEqual(unknown.state, "degraded");
    assert.match(unknown.lastError, /'kings-cross' is not on this host's track \(it has hogsmeade\)/);
    const backwards = harness({ stops: [{ at: 0.5 }, { at: "hogsmeade" }] });
    assert.strictEqual(backwards.service.status().state, "degraded");
    assert.match(backwards.service.status().lastError, /runs forward only/);
    assert.deepStrictEqual(backwards.intervals, []);
    assert.strictEqual(backwards.service.train.spawn(), false);
}

{
    // An older host: degraded, nothing scheduled, every call refused.
    const { service, intervals } = harness({}, null);
    const status = service.status();
    assert.strictEqual(status.state, "degraded");
    assert.match(status.lastError, /no World\.hogwartsExpress/);
    assert.strictEqual(status.train, null);
    assert.deepStrictEqual(intervals, []);
    assert.strictEqual(service.train.get(), null);
    assert.deepStrictEqual(service.train.stops(), []);
    assert.strictEqual(service.train.run(), false);
    assert.strictEqual(service.train.spawn(), false);
    assert.strictEqual(service.train.despawn(), false);
    service.stop();
}

{
    // enabled: false leaves the train to other scripts; it can still be read.
    const train = fakeTrain();
    const { service, intervals } = harness({ enabled: false }, train);
    assert.strictEqual(service.status().state, "disabled");
    assert.deepStrictEqual(intervals, []);
    assert.strictEqual(service.train.run(), false);
    assert.strictEqual(service.train.spawn(), false);
    assert.strictEqual(service.train.get()?.spawned, false);
    assert.deepStrictEqual(train.calls, []);
}

console.log("hmp-express tests passed");
