import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpExpressRouteStop } from "../types";
import type { ExpressConfig, ExpressDepartureConfig } from "./internal";

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const STOP_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
    return value as Record<string, unknown>;
}

function positive(value: unknown, label: string, maximum: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) {
        throw new TypeError(`${label} must be a number above 0 and at most ${maximum}`);
    }
    return value;
}

function departure(value: unknown, index: number): ExpressDepartureConfig {
    const label = `hmp-express departures[${index}]`;
    const raw = object(value, label);
    const match = typeof raw.time === "string" ? TIME_PATTERN.exec(raw.time.trim()) : null;
    if (!match) throw new TypeError(`${label}.time must be "HH:MM", from 00:00 to 23:59`);
    let days = [0, 1, 2, 3, 4, 5, 6];
    if (raw.days !== undefined) {
        if (!Array.isArray(raw.days) || !raw.days.length) throw new TypeError(`${label}.days must be a non-empty array of weekday names`);
        days = raw.days.map((day) => {
            const found = DAYS.indexOf(String(day).trim().toLowerCase());
            if (found < 0) throw new TypeError(`${label}.days has '${String(day)}', which is not a weekday name`);
            return found;
        });
        days = [...new Set(days)].sort((a, b) => a - b);
    }
    const hour = Number(match[1]), minute = Number(match[2]);
    return { time: `${String(hour).padStart(2, "0")}:${match[2]}`, minute: hour * 60 + minute, days };
}

function stop(value: unknown, index: number): HmpExpressRouteStop {
    const label = `hmp-express stops[${index}]`;
    const raw = object(value, label);
    let at: HmpExpressRouteStop["at"];
    if (typeof raw.at === "string") {
        if (!STOP_PATTERN.test(raw.at)) throw new TypeError(`${label}.at must be a stop id of 1-64 letters, digits, '_' or '-'`);
        at = raw.at;
    }
    else if (typeof raw.at === "number" && raw.at >= 0 && raw.at <= 1) at = raw.at;
    else throw new TypeError(`${label}.at must be a stop id or a t from 0 to 1`);
    const dwellSeconds = raw.dwellSeconds === undefined ? 120 : raw.dwellSeconds;
    if (!Number.isSafeInteger(dwellSeconds) || (dwellSeconds as number) < 0 || (dwellSeconds as number) > 3600) {
        throw new TypeError(`${label}.dwellSeconds must be an integer from 0 to 3600`);
    }
    return { at, dwellSeconds: dwellSeconds as number };
}

function normalizeConfig(raw: unknown): ExpressConfig {
    const value = object(raw, "hmp-express configuration");
    if (typeof value.enabled !== "boolean") throw new TypeError("hmp-express enabled must be a boolean");
    if (!Array.isArray(value.departures)) throw new TypeError("hmp-express departures must be an array");
    if (!Array.isArray(value.stops)) throw new TypeError("hmp-express stops must be an array");
    if (!Number.isSafeInteger(value.year) || (value.year as number) < 1 || (value.year as number) > 9999) {
        throw new TypeError("hmp-express year must be an integer from 1 to 9999");
    }
    return {
        enabled: value.enabled,
        departures: value.departures.map(departure),
        stops: value.stops.map(stop),
        speed: positive(value.speed, "hmp-express speed", 60),
        accel: positive(value.accel, "hmp-express accel", 10),
        decel: positive(value.decel, "hmp-express decel", 10),
        year: value.year as number,
    };
}

function loadConfig(Hmp: HmpLibServer, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): ExpressConfig {
    const env = options.env || process.env;
    // The game's own timetable (its HogwartsExpressSchedule table), driven straight through, at its own speeds.
    const defaults = {
        enabled: true,
        departures: [
            { time: "10:00", days: ["monday", "wednesday", "friday"] },
            { time: "21:00", days: ["saturday"] },
        ],
        stops: [],
        speed: 20,
        accel: 0.5,
        decel: 0.7,
        year: 1891,
    };
    const loaded = Hmp.config.load<Record<string, unknown>>(env.HMP_EXPRESS_CONFIG || "data/hmp-express.json", {
        cwd: options.cwd || process.cwd(),
        defaults,
    });
    return normalizeConfig(loaded);
}

export = { loadConfig, normalizeConfig };
