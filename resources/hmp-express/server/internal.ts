import type { HmpLogger } from "../../hmp-lib/types";
import type { HmpExpressRouteStop } from "../types";

export interface ExpressDepartureConfig {
    /** "HH:MM", as configured. */
    time: string;
    /** Minutes into the in-game day. */
    minute: number;
    /** Days of the week, 0 for Sunday. */
    days: number[];
}

export interface ExpressConfig {
    /** False leaves the train alone, to another script. */
    enabled: boolean;
    departures: ExpressDepartureConfig[];
    /** Stops in track order; empty drives straight through, as the game does. */
    stops: HmpExpressRouteStop[];
    speed: number;
    accel: number;
    decel: number;
    /** The year the day of the week is taken from while the server keeps the game's own (World.year 0). */
    year: number;
}

/** The server clock, as `World` reports it. */
export interface ExpressClock {
    hour: number;
    minute: number;
    day: number;
    month: number;
    year: number;
    /** In-game minutes per real second. */
    timeScale: number;
}

type Timer = ReturnType<typeof setTimeout>;

export interface ExpressServiceOptions {
    config: ExpressConfig;
    /** Null on a host without `World.hogwartsExpress`: the resource then runs nothing. */
    native: HogwartsMpHogwartsExpress | null;
    clock(): ExpressClock;
    logger?: Pick<HmpLogger, "info" | "warn">;
    now?: () => number;
    setTimer?: (handler: () => void, ms: number) => Timer;
    clearTimer?: (timer: Timer) => void;
    setInterval?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
    clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
}
