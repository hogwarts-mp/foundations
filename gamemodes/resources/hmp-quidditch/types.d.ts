export type HmpQuidditchMode = "snitchHunt" | "practice" | "match";
export type HmpQuidditchHouse = "gryffindor" | "hufflepuff" | "ravenclaw" | "slytherin";

export interface HmpQuidditchPlayer {
    id: number;
    nickname: string;
    sendChat?(message: string): void;
}

export interface HmpQuidditchStatus {
    state: "idle" | "forming" | "running" | "ending";
    mode: HmpQuidditchMode | null;
    players: number;
    activitySessionId: string | null;
    dependencies: { activities: string; houses: string; world: string };
}

export interface HmpQuidditch<P = HmpQuidditchPlayer> {
    status(): HmpQuidditchStatus;
    call(referee: P, mode?: HmpQuidditchMode, teamA?: HmpQuidditchHouse, teamB?: HmpQuidditchHouse, ffa?: boolean): void;
    start(starter: P, mode?: HmpQuidditchMode, solo?: boolean): void;
    stop(reason?: string): void;
}
