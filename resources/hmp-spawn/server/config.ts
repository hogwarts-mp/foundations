import type { HmpLibServer } from "../../hmp-lib/types";
import type { Player, SpawnConfig } from "./internal";

function loadConfig(Hmp: HmpLibServer<Player>, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): SpawnConfig {
    const env = options.env || process.env;
    const cwd = options.cwd || process.cwd();
    const defaults: SpawnConfig = {
        showSelector: true,
        allowLastLocation: true,
        saveLastLocation: true,
        defaultLocation: "hogwarts",
        teleportTimeoutMs: 120000,
        autoSaveMs: 60000,
        worldSpawn: null,
        respawnAtSpawn: false,
        locations: [
            {
                key: "hogwarts",
                label: "Hogwarts",
                description: "Return to the castle grounds.",
                areaId: "Overland",
                x: 366784,
                y: -461527,
                z: -82610,
                snapToGround: true,
            },
        ],
    };
    const config = Hmp.config.load<SpawnConfig>(env.HMP_SPAWN_CONFIG || "data/hmp-spawn.json", { cwd, defaults });
    if (env.HMP_SPAWN_SELECTOR) config.showSelector = Hmp.config.env.boolean(env.HMP_SPAWN_SELECTOR);
    if (env.HMP_SPAWN_LAST_LOCATION) config.allowLastLocation = Hmp.config.env.boolean(env.HMP_SPAWN_LAST_LOCATION);
    if (env.HMP_SPAWN_SAVE_LOCATION) config.saveLastLocation = Hmp.config.env.boolean(env.HMP_SPAWN_SAVE_LOCATION);
    if (env.HMP_SPAWN_DEFAULT) config.defaultLocation = String(env.HMP_SPAWN_DEFAULT).trim().toLowerCase();
    config.teleportTimeoutMs = Math.max(5000, Math.min(300000, Math.trunc(Number(config.teleportTimeoutMs)) || 120000));
    config.autoSaveMs = Math.max(0, Math.min(3600000, Math.trunc(Number(config.autoSaveMs)) || 0));
    if (!Array.isArray(config.locations) || !config.locations.length) throw new TypeError("hmp-spawn requires at least one configured location");
    return config;
}

export = { loadConfig };
// TypeScript source.
