import type {
    HmpWorld,
    HmpWorldEnvironmentConfig,
    HmpWorldEnvironmentState,
    HmpWorldPlayer,
    HmpWorldPolicy,
    HmpWorldSeason,
} from "../types";
import { SEASONS, type WorldServiceOptions } from "./internal";

interface WorldService<P extends HmpWorldPlayer> extends HmpWorld<P> {
    stop(): void;
    clientReady(player: P): number;
    disconnect(player: P): void;
}

function cloneEnvironment(value: HmpWorldEnvironmentConfig): HmpWorldEnvironmentConfig {
    return {
        weather: value.weather,
        time: { ...value.time },
        date: { ...value.date },
        season: value.season,
    };
}

function clonePolicy(value: HmpWorldPolicy): HmpWorldPolicy {
    return { ...value };
}

function numericSeason(value: HmpWorldSeason): 0 | 1 | 2 | 3 {
    return typeof value === "number" ? value : SEASONS[value];
}

function normalizePolicyPatch(current: HmpWorldPolicy, patch: Partial<HmpWorldPolicy>): HmpWorldPolicy {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("world policy patch must be an object");
    for (const key of ["removeBoundaryVolumes", "ambientPopulation", "nativeEncounters"] as const) {
        if (patch[key] !== undefined && typeof patch[key] !== "boolean") throw new TypeError(`world policy ${key} must be a boolean`);
    }
    return { ...current, ...patch };
}

function createWorldService<P extends HmpWorldPlayer>(options: WorldServiceOptions<P>): WorldService<P> {
    const { config, native, events, players } = options;
    const now = options.now || Date.now;
    const startedAt = now();
    const baselineEnvironment = Object.freeze(cloneEnvironment(config.environment));
    const baselinePolicy = Object.freeze(clonePolicy(config.policy));
    const readyClients = new Set<number>();
    let currentPolicy = Object.freeze(clonePolicy(config.policy));
    let state: "ready" | "stopped" = "ready";

    function ensureReady(): void {
        if (state === "stopped") throw new Error("hmp-world is stopped");
    }

    function environmentState(): HmpWorldEnvironmentState | null {
        return {
            weather: native.weather,
            hour: native.hour,
            minute: native.minute,
            second: native.second,
            day: native.day,
            month: native.month,
            year: native.year,
            season: native.season,
            timeScale: native.timeScale,
            revision: native.revision,
        };
    }

    function applyEnvironment(): HmpWorldEnvironmentState | null {
        ensureReady();
        const value = baselineEnvironment;
        if (!native.setTimeScale(0)) throw new Error("Framework rejected the hmp-world clock freeze");
        if (!native.setWeather(value.weather)) throw new Error(`Framework rejected weather '${value.weather}'`);
        if (!native.setDate(value.date.day, value.date.month, value.date.year)) throw new Error("Framework rejected the configured date");
        if (!native.setSeason(numericSeason(value.season))) throw new Error("Framework rejected the configured season");
        if (!native.setTime(value.time.hour, value.time.minute, value.time.second)) throw new Error("Framework rejected the configured time");
        if (!native.setTimeScale(value.time.scale)) throw new Error("Framework rejected the configured time scale");
        return environmentState();
    }

    function policyPayload(): string {
        return JSON.stringify({ contract: "hmp.world.policy/v1", ...currentPolicy });
    }

    function sync(player?: P): number {
        ensureReady();
        if (player) {
            if (player.connected === false) return 0;
            player.emit("hmp-world:policy", policyPayload());
            return 1;
        }
        events.emitAllClients("hmp-world:policy", policyPayload());
        return players().filter((entry) => entry.connected !== false).length;
    }

    function setPolicy(patch: Partial<HmpWorldPolicy>): Readonly<HmpWorldPolicy> {
        ensureReady();
        currentPolicy = Object.freeze(normalizePolicyPatch(currentPolicy, patch));
        sync();
        return currentPolicy;
    }

    function resetPolicy(): Readonly<HmpWorldPolicy> {
        ensureReady();
        currentPolicy = Object.freeze(clonePolicy(baselinePolicy));
        sync();
        return currentPolicy;
    }

    const environment = Object.freeze({
        baseline: () => cloneEnvironment(baselineEnvironment),
        state: environmentState,
        reset: applyEnvironment,
        setWeather: (weather: string) => { ensureReady(); return native.setWeather(weather); },
        setTime: (hour: number, minute: number, second = 0) => { ensureReady(); return native.setTime(hour, minute, second); },
        setDate: (day: number, month: number, year = 0) => { ensureReady(); return native.setDate(day, month, year); },
        setSeason: (season: HmpWorldSeason) => { ensureReady(); return native.setSeason(numericSeason(season)); },
        setTimeScale: (scale: number) => { ensureReady(); return native.setTimeScale(scale); },
    });
    const policy = Object.freeze({
        baseline: () => clonePolicy(baselinePolicy),
        current: () => clonePolicy(currentPolicy),
        set: setPolicy,
        reset: resetPolicy,
        sync,
    });

    applyEnvironment();

    return Object.freeze({
        environment,
        policy,
        status: () => ({ state, environment: environmentState(), policy: clonePolicy(currentPolicy), readyClients: readyClients.size, uptimeMs: now() - startedAt }),
        stop() {
            if (state === "stopped") return;
            state = "stopped";
            readyClients.clear();
        },
        clientReady(player: P) {
            ensureReady();
            readyClients.add(player.id);
            return sync(player);
        },
        disconnect(player: P) { readyClients.delete(player.id); },
    }) as WorldService<P>;
}

export = { createWorldService, numericSeason, normalizePolicyPatch };
