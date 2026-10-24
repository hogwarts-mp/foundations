import type { HmpExpressMoveOptions, HmpExpressPosition, HmpExpressServer, HmpExpressStatus } from "../types";
import type { ExpressServiceOptions } from "./internal";

const WEEK_MINUTES = 7 * 1440;
// A clock set forward further than this (or three seconds of a fast clock) skips the departures in between instead
// of running them all.
const MAX_STEP_MINUTES = 60;

interface ExpressService extends HmpExpressServer {
    /** The trainStopped event. */
    stopped(): void;
    /** The trainEnded event. */
    ended(): void;
    stop(): void;
}

interface Run {
    departure: string | null;
    /** Index of the stop it is running to or standing at; the stop count once it leaves for the far end. */
    leg: number;
    leavesAt: number | null;
    timer: ReturnType<typeof setTimeout> | null;
}

function createExpressService(options: ExpressServiceOptions): ExpressService {
    const { config, native, clock, logger } = options;
    const now = options.now || Date.now;
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    const every = options.setInterval || setInterval;
    const clearEvery = options.clearInterval || clearInterval;
    const startedAt = now();
    const moveOptions: HmpExpressMoveOptions = { speed: config.speed, accel: config.accel, decel: config.decel };
    let state: HmpExpressStatus["state"] = !config.enabled ? "disabled" : native ? "ready" : "degraded";
    let lastError = state === "degraded" ? "this server build has no World.hogwartsExpress" : "";
    let run: Run | null = null;
    // The train out is one this resource spawned, so stopping the resource removes it.
    let owned = false;
    // trainEnded events still to come for trains a spawn() replaced; the host sends them before trainSpawned.
    let staleEnds = 0;

    // The route must exist on this host's track and run forward along it.
    if (state === "ready") {
        const known = native!.stops;
        let previous = -1;
        for (const entry of config.stops) {
            const t = typeof entry.at === "number" ? entry.at : known.find((candidate) => candidate.id === entry.at)?.t;
            if (t === undefined) {
                state = "degraded";
                lastError = `stop '${entry.at}' is not on this host's track (it has ${known.map((candidate) => candidate.id).join(", ") || "none"})`;
                break;
            }
            if (t <= previous) {
                state = "degraded";
                lastError = `stop '${entry.at}' is not past the one before it; the train runs forward only`;
                break;
            }
            previous = t;
        }
    }

    function minuteOfWeek(): number | null {
        const { hour, minute, day, month, year } = clock();
        const date = new Date(0);
        date.setUTCFullYear(year || config.year, month - 1, day);
        const minutes = date.getUTCDay() * 1440 + hour * 60 + minute;
        return Number.isFinite(minutes) ? minutes : null;
    }

    function endRun(): void {
        if (run?.timer) clearTimer(run.timer);
        run = null;
    }

    function drive(leg: number): boolean {
        const stop = config.stops[leg];
        return stop ? native!.moveTo(stop.at, moveOptions) : native!.depart(moveOptions);
    }

    function start(departure: string | null): boolean {
        if (state !== "ready" || native!.get().spawned || !native!.spawn(0)) return false;
        owned = true;
        endRun();
        run = { departure, leg: 0, leavesAt: null, timer: null };
        if (drive(0)) return true;
        logger?.warn(`The ${departure || "requested"} run was refused; the train was removed`);
        endRun();
        native!.despawn();
        return false;
    }

    function leave(): void {
        if (!run) return;
        run.timer = null;
        run.leavesAt = null;
        run.leg += 1;
        if (drive(run.leg)) return;
        logger?.warn("The Hogwarts Express could not leave its stop; it was removed");
        endRun();
        native!.despawn();
    }

    let last = minuteOfWeek();
    function tick(): void {
        const current = minuteOfWeek();
        if (current === null) return;
        const previous = last ?? current;
        last = current;
        const step = (current - previous + WEEK_MINUTES) % WEEK_MINUTES;
        if (step === 0 || step > Math.max(MAX_STEP_MINUTES, 3 * (Number(clock().timeScale) || 0))) return;
        for (const departure of config.departures) {
            for (const day of departure.days) {
                const ahead = (day * 1440 + departure.minute - previous + WEEK_MINUTES) % WEEK_MINUTES;
                if (ahead === 0 || ahead > step) continue;
                if (native!.get().spawned) logger?.info(`${departure.time} departure skipped: the train is still out`);
                else if (start(departure.time)) logger?.info(`${departure.time} departure${config.stops.length ? `, stopping at ${config.stops.map((entry) => entry.at).join(", ")}` : ""}`);
            }
        }
    }
    const poll = state === "ready" && config.departures.length ? every(tick, 1000) : null;

    // A call from another resource takes the train off the timetable: from then on that caller drives it.
    function manual(call: () => boolean): boolean {
        if (state !== "ready" || !call()) return false;
        endRun();
        return true;
    }

    const train = Object.freeze({
        get: () => native ? { ...native.get() } : null,
        stops: () => native ? native.stops.map((entry) => ({ id: entry.id, t: entry.t })) : [],
        run: () => start(null),
        spawn: (at: HmpExpressPosition = 0) => {
            const replacing = state === "ready" && native!.get().spawned;
            if (!manual(() => native!.spawn(at))) return false;
            if (replacing) staleEnds += 1;
            owned = true;
            return true;
        },
        moveTo: (at: HmpExpressPosition, options?: HmpExpressMoveOptions) => manual(() => native!.moveTo(at, options)),
        depart: (options?: HmpExpressMoveOptions) => manual(() => native!.depart(options)),
        halt: (options?: { decel?: number }) => manual(() => native!.halt(options)),
        despawn: () => manual(() => native!.despawn()),
    });

    return Object.freeze({
        train,
        status: (): HmpExpressStatus => ({
            state,
            lastError,
            departures: config.departures.length,
            stops: config.stops.length,
            train: train.get(),
            run: run ? { departure: run.departure, stop: config.stops[run.leg]?.at ?? null, leavesAt: run.leavesAt } : null,
            uptimeMs: now() - startedAt,
        }),
        stopped() {
            if (!run || run.leavesAt !== null || run.leg >= config.stops.length) return;
            const dwellMs = config.stops[run.leg].dwellSeconds * 1000;
            run.leavesAt = now() + dwellMs;
            run.timer = setTimer(leave, dwellMs);
        },
        ended() {
            if (staleEnds > 0) { staleEnds -= 1; return; }
            endRun();
            owned = false;
        },
        stop() {
            if (state === "stopped") return;
            if (poll) clearEvery(poll);
            endRun();
            if (owned && native?.get().spawned) native.despawn();
            owned = false;
            state = "stopped";
        },
    });
}

export = { createExpressService };
