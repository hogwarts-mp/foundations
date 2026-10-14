import type { HmpInteractionWorldObject } from "../../../../resources/hmp-interact/types";

export interface Vector3Like {
    x: number;
    y: number;
    z: number;
}

export interface GauntletPlayer {
    id: number;
    nickname: string;
    connected?: boolean;
    position: Vector3Like;
    virtualWorld?: number;
    emit(eventName: string, payload?: unknown): void;
    sendChat(message: string): void;
    location?(): ({ areaId: string; regionId: string } & Vector3Like) | null;
}

export interface DifficultyPreset {
    waves: number;
    baseSpawns: number;
    spawnGrowth: number;
    hpGrowth: number;
    scaleStep: number;
    scaleMax: number;
    bossEvery: number;
    maxAlive: number;
    intermission: number;
}

export interface BossDefinition {
    id: string;
    baseHp: number;
}

export interface InteractionConfig {
    enabled: boolean;
    position: Vector3Like;
    areaId?: string;
    regionId?: string;
    radius: number;
    promptDistance: number;
    promptOffsetZ: number;
    label: string;
    object?: HmpInteractionWorldObject;
}

export interface GauntletConfig {
    presets: Record<string, DifficultyPreset>;
    defaultPreset: string;
    bosses: BossDefinition[];
    hidden: string[];
    groups: Array<[prefix: string, label: string]>;
    arena: {
        ringRadius: number;
        ringJitter: number;
        baseEnemyHp: number;
        intermissionDefault: number;
    };
    players: {
        scaleFodder: boolean;
        perPlayerBonus: number;
        maxPlayers: number;
        lobbyTtlSeconds: number;
    };
    interaction: InteractionConfig;
}

export interface ResolvedRunConfig extends DifficultyPreset {
    preset: string;
    scaleFodder: boolean;
    perPlayerBonus: number;
    pool: string[];
}

export interface EnemyMenuEntry {
    id: string;
    label: string;
    group: string;
}

export interface ConfigureModel {
    presets: string[];
    presetParams: Record<string, DifficultyPreset>;
    defaultPreset: string;
    enemies: EnemyMenuEntry[];
    running: boolean;
}

export interface HudState {
    active: boolean;
    wave?: number;
    waves?: number;
    enemies?: number;
    score?: number;
}
