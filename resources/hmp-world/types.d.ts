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

export interface HmpWorldPolicy {
    /** Destroy native mount boundary volumes, including Hogsmeade's no-fly zone. */
    removeBoundaryVolumes: boolean;
    /** Restore Hogwarts Legacy's ambient student and seat-filler population. */
    ambientPopulation: boolean;
    /** Let each client's game spawn its own enemy encounters; false suppresses them (server `World.setEncounterPolicy`). */
    nativeEncounters: boolean;
}

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
}

export interface HmpWorld<P = HmpWorldPlayer> {
    environment: HmpWorldEnvironmentApi;
    policy: HmpWorldPolicyApi<P>;
    status(): HmpWorldStatus;
}

export interface HmpWorldClientPolicyApi {
    current(): Readonly<HmpWorldPolicy> | null;
    /** Reapply the most recent server-authored policy after a temporary client-side override. */
    restore(): boolean;
}

export interface HmpWorldClientStatus {
    state: "ready" | "stopped";
    policy: Readonly<HmpWorldPolicy> | null;
    boundaryVolumesChanged: number;
}

export interface HmpWorldClient {
    policy: HmpWorldClientPolicyApi;
    status(): HmpWorldClientStatus;
}
