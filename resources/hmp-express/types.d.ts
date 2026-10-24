/**
 * A spot on the Hogwarts Express's one track: `t` from 0 (the whole train just on the track, south of
 * Hogsmeade) to 1 (the far end), or the id of one of the host's stops, such as `"hogsmeade"`.
 */
export type HmpExpressPosition = number | string;

export type HmpExpressDay = "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";

export interface HmpExpressMoveOptions {
    /** Cruise in m/s, up to 60. The game's own is 20. */
    speed?: number;
    /** Pulling away in m/s², up to 10. */
    accel?: number;
    /** Braking in m/s², up to 10. */
    decel?: number;
}

/** A named spot along the track, as the host lists it. */
export interface HmpExpressStop {
    id: string;
    t: number;
}

/** Where the train is now, as `World.hogwartsExpress.get()` reports it. */
export interface HmpExpressTrain {
    spawned: boolean;
    moving: boolean;
    departing: boolean;
    t: number;
    /** m/s. */
    speed: number;
    /** The t a moveTo or halt brakes onto. */
    target: number | null;
    /** Seconds until it stops, or until a departure leaves the track. */
    seconds: number | null;
}

export interface HmpExpressDeparture {
    /** In-game time on the server clock, "HH:MM". */
    time: string;
    /** Days of the in-game week it runs on. */
    days: HmpExpressDay[];
}

export interface HmpExpressRouteStop {
    at: HmpExpressPosition;
    /** Real seconds the train stands there before it goes on. */
    dwellSeconds: number;
}

/** The timetabled run the train is on. */
export interface HmpExpressRun {
    /** The departure that sent it ("10:00"), or null for one sent through `train.run()`. */
    departure: string | null;
    /** The stop it is running to or standing at; null once it is leaving for the far end. */
    stop: HmpExpressPosition | null;
    /** While it stands at that stop: when it goes on (epoch ms). */
    leavesAt: number | null;
}

export interface HmpExpressStatus {
    /** "disabled" with `enabled: false`; "degraded" on a host without `World.hogwartsExpress` or with a route it cannot run. */
    state: "ready" | "disabled" | "degraded" | "stopped";
    lastError: string;
    departures: number;
    stops: number;
    /** Null on a host without `World.hogwartsExpress`. */
    train: HmpExpressTrain | null;
    run: HmpExpressRun | null;
    uptimeMs: number;
}

export interface HmpExpressTrainApi {
    /** Null on a host without `World.hogwartsExpress`. */
    get(): HmpExpressTrain | null;
    /** The host's named stops; empty on a host without the train. */
    stops(): HmpExpressStop[];
    /** Sends the train down the configured route now, as a departure would. False while a train is out. */
    run(): boolean;
    /**
     * The host's own calls. Each one that succeeds ends the timetabled run: the caller drives the train from
     * there. All are false while the resource is disabled, degraded or stopped.
     */
    spawn(at?: HmpExpressPosition): boolean;
    moveTo(at: HmpExpressPosition, options?: HmpExpressMoveOptions): boolean;
    depart(options?: HmpExpressMoveOptions): boolean;
    /** `decel: Infinity` stops it dead. */
    halt(options?: { decel?: number }): boolean;
    despawn(): boolean;
}

export interface HmpExpressServer {
    train: HmpExpressTrainApi;
    status(): HmpExpressStatus;
}
