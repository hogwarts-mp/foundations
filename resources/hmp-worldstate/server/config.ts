import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpWorldStatePlayer } from "../types";
import type { WorldStateConfig } from "./internal";

function cleanId(value: unknown, label: string): string {
    const result = String(value || "").trim();
    if (!result || result.length > 64) throw new TypeError(`${label} must be a non-empty string up to 64 characters`);
    return result;
}

function positiveInt(value: unknown, fallback: number, label: string): number {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${label} must be a positive integer`);
    return n;
}

function loadConfig(Hmp: HmpLibServer<HmpWorldStatePlayer>, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): WorldStateConfig {
    const env = options.env || process.env;
    const defaults: WorldStateConfig = {
        command: "worldstate",
        enableCommands: true,
        adminGroups: [{ key: "admin", minimumGrade: 1 }],
        breakables: { enabled: true, reportLimit: { limit: 20, windowMs: 10000 } },
    };
    const loaded = Hmp.config.load<WorldStateConfig & Record<string, unknown>>(env.HMP_WORLDSTATE_CONFIG || "data/hmp-worldstate.json", {
        cwd: options.cwd || process.cwd(),
        defaults: defaults as WorldStateConfig & Record<string, unknown>,
    });
    const command = cleanId(env.HMP_WORLDSTATE_COMMAND || loaded.command || "worldstate", "hmp-worldstate command").toLowerCase();
    const enableCommands = env.HMP_WORLDSTATE_COMMANDS === undefined ? loaded.enableCommands !== false : Hmp.config.env.boolean(env.HMP_WORLDSTATE_COMMANDS, true);
    if (!Array.isArray(loaded.adminGroups)) throw new TypeError("hmp-worldstate adminGroups must be an array");
    const adminGroups = loaded.adminGroups.map((entry, index) => ({
        key: cleanId(entry?.key, `admin group ${index} key`).toLowerCase(),
        minimumGrade: Number.isSafeInteger(Number(entry?.minimumGrade)) ? Number(entry.minimumGrade) : 0,
    }));
    const rawBreakables = loaded.breakables && typeof loaded.breakables === "object" ? loaded.breakables : defaults.breakables;
    const rawLimit = rawBreakables.reportLimit && typeof rawBreakables.reportLimit === "object" ? rawBreakables.reportLimit : defaults.breakables.reportLimit;
    const breakables = {
        enabled: rawBreakables.enabled !== false,
        reportLimit: {
            limit: positiveInt(rawLimit.limit, defaults.breakables.reportLimit.limit, "breakables.reportLimit.limit"),
            windowMs: positiveInt(rawLimit.windowMs, defaults.breakables.reportLimit.windowMs, "breakables.reportLimit.windowMs"),
        },
    };
    return { command, enableCommands, adminGroups, breakables };
}

export = { loadConfig };
