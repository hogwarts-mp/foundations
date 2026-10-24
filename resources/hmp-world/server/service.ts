import type {
    HmpWorld,
    HmpWorldEnvironmentConfig,
    HmpWorldEnvironmentState,
    HmpWorldPlayer,
    HmpWorldPolicy,
    HmpWorldSeason,
} from "../types";
import { SEASONS, type WorldServiceOptions } from "./internal";

type PlayerPolicy = Pick<HmpWorldPolicy, "fastTravel">;

// What a connection starts with on the host.
const PLAYER_DEFAULTS: Readonly<PlayerPolicy> = Object.freeze({ fastTravel: true });

interface WorldService<P extends HmpWorldPlayer> extends HmpWorld<P> {
    stop(): void;
    clientReady(player: P): number;
    connect(player: P): void;
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
    for (const key of ["removeBoundaryVolumes", "ambientPopulation", "playerCollision", "fastTravel"] as const) {
        if (patch[key] !== undefined && typeof patch[key] !== "boolean") throw new TypeError(`world policy ${key} must be a boolean`);
    }
    if (patch.encounters !== undefined && patch.encounters !== "suppressed" && patch.encounters !== "server") {
        throw new TypeError('world policy encounters must be "suppressed" or "server"');
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

    // The host applies encounters and player collision for every client, including late joiners, so they are not part of the client sync.
    function applyEncounterPolicy(value: HmpWorldPolicy): void {
        if (!native.setEncounterPolicy(value.encounters)) throw new Error(`Framework rejected encounter policy '${value.encounters}'`);
    }

    // A host without World.setPlayerCollision keeps players walking through each other.
    function applyPlayerCollision(value: HmpWorldPolicy): void {
        if (typeof native.setPlayerCollision !== "function") return;
        if (!native.setPlayerCollision(value.playerCollision)) throw new Error("Framework rejected the player collision policy");
    }

    // The host holds these per connection, so a player is sent only what differs from what they have. A host
    // without the setter leaves them at its default.
    function applyPlayerPolicy(player: P, next: PlayerPolicy, previous: PlayerPolicy): void {
        if (player.connected === false) return;
        try {
            if (next.fastTravel !== previous.fastTravel) player.setFastTravelEnabled?.(next.fastTravel);
        }
        catch (_) { /* left before it applied */ }
    }

    function commitPolicy(next: HmpWorldPolicy): Readonly<HmpWorldPolicy> {
        if (next.encounters !== currentPolicy.encounters) applyEncounterPolicy(next);
        if (next.playerCollision !== currentPolicy.playerCollision) applyPlayerCollision(next);
        for (const player of players()) applyPlayerPolicy(player, next, currentPolicy);
        currentPolicy = Object.freeze(next);
        sync();
        return currentPolicy;
    }

    function policyPayload(): string {
        const { removeBoundaryVolumes, ambientPopulation } = currentPolicy;
        return JSON.stringify({ contract: "hmp.world.policy/v2", removeBoundaryVolumes, ambientPopulation });
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
        return commitPolicy(normalizePolicyPatch(currentPolicy, patch));
    }

    function resetPolicy(): Readonly<HmpWorldPolicy> {
        ensureReady();
        return commitPolicy(clonePolicy(baselinePolicy));
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
    applyEncounterPolicy(currentPolicy);
    applyPlayerCollision(currentPolicy);
    for (const player of players()) applyPlayerPolicy(player, currentPolicy, PLAYER_DEFAULTS);

    return Object.freeze({
        environment,
        policy,
        status: () => ({ state, environment: environmentState(), policy: clonePolicy(currentPolicy), readyClients: readyClients.size, uptimeMs: now() - startedAt }),
        stop() {
            if (state === "stopped") return;
            state = "stopped";
            readyClients.clear();
            // A new connection starts at the host's defaults, so those online get theirs back too.
            for (const player of players()) applyPlayerPolicy(player, PLAYER_DEFAULTS, currentPolicy);
        },
        clientReady(player: P) {
            ensureReady();
            readyClients.add(player.id);
            return sync(player);
        },
        connect(player: P) {
            if (state === "stopped") return;
            applyPlayerPolicy(player, currentPolicy, PLAYER_DEFAULTS);
        },
        disconnect(player: P) { readyClients.delete(player.id); },
    }) as WorldService<P>;
}

export = { createWorldService, numericSeason, normalizePolicyPatch };
