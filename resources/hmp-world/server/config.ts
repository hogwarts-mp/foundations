import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpWorldEncounters, HmpWorldPlayer, HmpWorldSeason } from "../types";
import { SEASONS, type WorldConfig } from "./internal";

function finiteInteger(value: unknown, label: string, minimum: number, maximum: number): number {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
        throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
    }
    return number;
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number): number {
    const number = Number(value);
    if (!Number.isFinite(number) || number < minimum || number > maximum) {
        throw new TypeError(`${label} must be a number from ${minimum} to ${maximum}`);
    }
    return number;
}

function boolean(value: unknown, label: string, fallback?: boolean): boolean {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
    return value;
}

function encounters(value: unknown, label: string): HmpWorldEncounters {
    if (value === undefined) return "suppressed";
    if (value !== "suppressed" && value !== "server") throw new TypeError(`${label} must be "suppressed" or "server"`);
    return value;
}

function weather(value: unknown): string {
    const result = String(value || "").trim();
    if (!result || result.length > 128) throw new TypeError("hmp-world environment.weather must be a non-empty string up to 128 characters");
    return result;
}

function season(value: unknown): HmpWorldSeason {
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase() as keyof typeof SEASONS;
        if (normalized in SEASONS) return normalized;
    }
    return finiteInteger(value, "hmp-world environment.season", 0, 3) as 0 | 1 | 2 | 3;
}

function normalizeConfig(raw: unknown): WorldConfig {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("hmp-world configuration must be an object");
    const value = raw as Record<string, unknown>;
    if (!value.environment || typeof value.environment !== "object" || Array.isArray(value.environment)) throw new TypeError("hmp-world environment must be an object");
    if (!value.policy || typeof value.policy !== "object" || Array.isArray(value.policy)) throw new TypeError("hmp-world policy must be an object");
    const environment = value.environment as Record<string, unknown>;
    const time = environment.time as Record<string, unknown>;
    const date = environment.date as Record<string, unknown>;
    const policy = value.policy as Record<string, unknown>;
    if (!time || typeof time !== "object" || Array.isArray(time)) throw new TypeError("hmp-world environment.time must be an object");
    if (!date || typeof date !== "object" || Array.isArray(date)) throw new TypeError("hmp-world environment.date must be an object");
    return {
        environment: {
            weather: weather(environment.weather),
            time: {
                hour: finiteInteger(time.hour, "hmp-world environment.time.hour", 0, 23),
                minute: finiteInteger(time.minute, "hmp-world environment.time.minute", 0, 59),
                second: finiteInteger(time.second, "hmp-world environment.time.second", 0, 59),
                scale: finiteNumber(time.scale, "hmp-world environment.time.scale", 0, 600),
            },
            date: {
                day: finiteInteger(date.day, "hmp-world environment.date.day", 1, 31),
                month: finiteInteger(date.month, "hmp-world environment.date.month", 1, 12),
                year: finiteInteger(date.year, "hmp-world environment.date.year", 0, 65535),
            },
            season: season(environment.season),
        },
        policy: {
            removeBoundaryVolumes: boolean(policy.removeBoundaryVolumes, "hmp-world policy.removeBoundaryVolumes"),
            ambientPopulation: boolean(policy.ambientPopulation, "hmp-world policy.ambientPopulation"),
            encounters: encounters(policy.encounters, "hmp-world policy.encounters"),
            playerCollision: boolean(policy.playerCollision, "hmp-world policy.playerCollision", false),
            fastTravel: boolean(policy.fastTravel, "hmp-world policy.fastTravel", true),
            keepHealthOnTravel: boolean(policy.keepHealthOnTravel, "hmp-world policy.keepHealthOnTravel", false),
            jump: boolean(policy.jump, "hmp-world policy.jump", true),
            sprint: boolean(policy.sprint, "hmp-world policy.sprint", true),
        },
    };
}

function loadConfig(Hmp: HmpLibServer<HmpWorldPlayer>, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): WorldConfig {
    const env = options.env || process.env;
    const defaults: WorldConfig = {
        environment: {
            weather: "Clear",
            time: { hour: 9, minute: 0, second: 0, scale: 1 },
            date: { day: 1, month: 9, year: 0 },
            season: "autumn",
        },
        policy: {
            removeBoundaryVolumes: true,
            ambientPopulation: false,
            encounters: "suppressed",
            playerCollision: false,
            fastTravel: true,
            keepHealthOnTravel: false,
            jump: true,
            sprint: true,
        },
    };
    const loaded = Hmp.config.load<WorldConfig & Record<string, unknown>>(env.HMP_WORLD_CONFIG || "data/hmp-world.json", {
        cwd: options.cwd || process.cwd(),
        defaults: defaults as WorldConfig & Record<string, unknown>,
    });
    return normalizeConfig(loaded);
}

export = { loadConfig, normalizeConfig, season };
