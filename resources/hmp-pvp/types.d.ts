export interface HmpPvpHit {
    casterId: number;
    victimId: number;
    spellId: number;
    spell: string;
    damage: number;
    duration: number;
    /** The floor the victim's client applies: the rules' kneelHp under a kneel defeat, else 0. */
    minHp?: number;
    dotSeconds?: number;
    defeat?: "death" | "kneel";
    victimHp?: number;
    victimMax?: number;
}

export type HmpPvpDecision = void | boolean | number | { allow?: boolean; damage?: number; duration?: number; minHp?: number };

export interface HmpPvpRule {
    id: string;
    resource: string;
    /** Higher priority evaluates first. The first non-undefined decision is final. */
    priority: number;
    decide(hit: Readonly<HmpPvpHit>): HmpPvpDecision;
}

export interface HmpPvpRuleInfo { id: string; resource: string; priority: number }

export interface HmpPvpPlayer { id: number; nickname?: string; emit(eventName: string, payload?: unknown): void; sendChat?(message: string): void }

export interface HmpPvpPolicyApi {
    register(rule: HmpPvpRule): () => boolean;
    unregister(id: string, resource: string): boolean;
    clear(resource: string): number;
    get(id: string, resource: string): HmpPvpRuleInfo | null;
    list(resource?: string): HmpPvpRuleInfo[];
    evaluate(hit: HmpPvpHit): HmpPvpDecision;
}

export interface HmpPvpStatus {
    state: "ready" | "stopped";
    defaultDecision: "allow" | "deny";
    lethalMode: boolean;
    rules: number;
    evaluated: number;
    allowed: number;
    denied: number;
    errors: number;
    uptimeMs: number;
}

export interface HmpPvpModeApi<P = HmpPvpPlayer> {
    isLethal(): boolean;
    setLethal(enabled: boolean, context?: { resource?: string; actor?: P; reason?: string }): boolean;
    sync(player?: P | null): boolean;
}

export interface HmpPvp<P = HmpPvpPlayer> {
    policy: HmpPvpPolicyApi;
    mode: HmpPvpModeApi<P>;
    vitals(playerId: number): { hp: number; max: number; level: number; ageMs: number } | null;
    status(): HmpPvpStatus;
}

export interface HmpPvpClient {
    mode: {
        isLethal(): boolean;
    };
}
