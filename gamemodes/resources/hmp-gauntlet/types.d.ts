/** Party-size bracket a ranked run is scored in. */
export type HmpGauntletBucket = "solo" | "duo" | "party" | "free";

export interface HmpGauntletParticipant {
    playerId: number;
    nickname: string;
    /** The active hmp-core character's name, or null when none is selected. */
    character: string | null;
}

/** Payload of the server `hmp-gauntlet:complete` event, raised once for every run that ends. */
export interface HmpGauntletCompletion {
    won: boolean;
    /** Stopped with `/gauntlet stop`; cancelled runs are never scored. */
    cancelled: boolean;
    wave: number;
    /** Configured wave count; 0 for an endless run. */
    waves: number;
    endless: boolean;
    score: number;
    preset: string;
    bucket: HmpGauntletBucket;
    ranked: boolean;
    host: string | null;
    /** Participants still connected when the run ended. */
    participants: HmpGauntletParticipant[];
    /** Everyone who took part, connected or not. */
    participantCount: number;
    activitySessionId: string;
    finishedAt: string;
}
