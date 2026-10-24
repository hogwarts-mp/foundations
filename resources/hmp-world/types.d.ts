export type HmpWorldSeason = "spring" | "summer" | "autumn" | "winter" | 0 | 1 | 2 | 3;

export interface HmpWorldTimeConfig {
    hour: number;
    minute: number;
    second: number;
    scale: number;
}

export interface HmpWorldDateConfig {
    day: number;
    month: number;
    /** Zero preserves Hogwarts Legacy's native year. */
    year: number;
}

export interface HmpWorldEnvironmentConfig {
    weather: string;
    time: HmpWorldTimeConfig;
    date: HmpWorldDateConfig;
    season: HmpWorldSeason;
}

/**
 * Who spawns the Overland's enemy camps and roaming world events: nobody (`suppressed`), or the server as NPCs
 * every player shares (`server`). A host newer than 1.9.2 also keeps quest and dungeon spawners shut under
 * both; 1.9 through 1.9.2 leaves them to the game, which spawns them on one client alone.
 */
export type HmpWorldEncounters = "suppressed" | "server";

export interface HmpWorldPolicy {
    /** Destroy native mount boundary volumes, including Hogsmeade's no-fly zone. */
    removeBoundaryVolumes: boolean;
    /** Restore Hogwarts Legacy's ambient student and seat-filler population. */
    ambientPopulation: boolean;
    /** Applied by the server for every client (`World.setEncounterPolicy`); clients are not sent it. */
    encounters: HmpWorldEncounters;
    /** Players block each other's movement, applied by the server for every client (`World.setPlayerCollision`). */
    playerCollision: boolean;
    /** Let players fast travel from their own map, applied by the server to each player (`player.setFastTravelEnabled`). */
    fastTravel: boolean;
    /** Carry each player's health over map loads, applied by the server to each player (`player.setKeepHealthOnTravel`). */
    keepHealthOnTravel: boolean;
}

/** The part of the policy each client applies itself. */
export type HmpWorldClientPolicy = Pick<HmpWorldPolicy, "removeBoundaryVolumes" | "ambientPopulation">;

export interface HmpWorldEnvironmentState {
    weather: string;
    hour: number;
    minute: number;
    second: number;
    day: number;
    month: number;
    year: number;
    season: 0 | 1 | 2 | 3;
    timeScale: number;
    revision: number;
}

export interface HmpWorldEnvironmentApi {
    baseline(): Readonly<HmpWorldEnvironmentConfig>;
    state(): HmpWorldEnvironmentState | null;
    reset(): HmpWorldEnvironmentState | null;
    setWeather(weather: string): boolean;
    setTime(hour: number, minute: number, second?: number): boolean;
    setDate(day: number, month: number, year?: number): boolean;
    setSeason(season: HmpWorldSeason): boolean;
    setTimeScale(scale: number): boolean;
}

export interface HmpWorldPolicyApi<P = HmpWorldPlayer> {
    baseline(): Readonly<HmpWorldPolicy>;
    current(): Readonly<HmpWorldPolicy>;
    set(patch: Partial<HmpWorldPolicy>): Readonly<HmpWorldPolicy>;
    reset(): Readonly<HmpWorldPolicy>;
    sync(player?: P): number;
}

export interface HmpWorldStatus {
    state: "ready" | "stopped";
    environment: HmpWorldEnvironmentState | null;
    policy: Readonly<HmpWorldPolicy>;
    readyClients: number;
    uptimeMs: number;
}

export interface HmpWorldPlayer {
    id: number;
    nickname: string;
    connected?: boolean;
    emit(eventName: string, payload?: unknown): void;
    /** Absent on a host older than the fast-travel gate. */
    setFastTravelEnabled?(on: boolean): void;
    /** Absent on a host older than keeping health over map loads. */
    setKeepHealthOnTravel?(on: boolean): void;
}

export interface HmpWorld<P = HmpWorldPlayer> {
    environment: HmpWorldEnvironmentApi;
    policy: HmpWorldPolicyApi<P>;
    status(): HmpWorldStatus;
}

export interface HmpWorldClientPolicyApi {
    current(): Readonly<HmpWorldClientPolicy> | null;
    /** Reapply the most recent server-authored policy after a temporary client-side override. */
    restore(): boolean;
}

export interface HmpWorldClientStatus {
    state: "ready" | "stopped";
    policy: Readonly<HmpWorldClientPolicy> | null;
    boundaryVolumesChanged: number;
}

export interface HmpWorldClient {
    policy: HmpWorldClientPolicyApi;
    status(): HmpWorldClientStatus;
}
