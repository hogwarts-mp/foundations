import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpBeastPlayer } from "../types";
import type { BeastsConfig } from "./internal";

function flag(value: unknown, fallback: boolean, label: string): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
    return value;
}

function loadConfig(Hmp: HmpLibServer<HmpBeastPlayer>, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): BeastsConfig {
    const env = options.env || process.env;
    const defaults: BeastsConfig = { command: "beasts", enableCommands: true, release: { respawn: true, capturable: false } };
    const loaded = Hmp.config.load<BeastsConfig & Record<string, unknown>>(env.HMP_BEASTS_CONFIG || "data/hmp-beasts.json", {
        cwd: options.cwd || process.cwd(),
        defaults: defaults as BeastsConfig & Record<string, unknown>,
    });
    const release = loaded.release && typeof loaded.release === "object" && !Array.isArray(loaded.release) ? loaded.release as Record<string, unknown> : {};
    const command = loaded.command === undefined ? defaults.command : loaded.command;
    if (typeof command !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/i.test(command)) {
        throw new TypeError("hmp-beasts command must be 1-32 letters, digits, '_' or '-', starting with a letter");
    }
    return {
        command: command.toLowerCase(),
        enableCommands: flag(loaded.enableCommands, defaults.enableCommands, "hmp-beasts enableCommands"),
        release: {
            respawn: flag(release.respawn, defaults.release.respawn, "hmp-beasts release.respawn"),
            capturable: flag(release.capturable, defaults.release.capturable, "hmp-beasts release.capturable"),
        },
    };
}

export = { loadConfig };
