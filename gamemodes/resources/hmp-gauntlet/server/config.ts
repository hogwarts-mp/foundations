import type { DifficultyPreset, GauntletConfig, InteractionConfig } from "../shared/types";

export const DEFAULT_CONFIG: GauntletConfig = {
    presets: {
        easy: { waves: 8, baseSpawns: 3, spawnGrowth: 1, hpGrowth: 1.10, scaleStep: 0.04, scaleMax: 1.6, bossEvery: 0, maxAlive: 6, intermission: 6 },
        normal: { waves: 10, baseSpawns: 4, spawnGrowth: 2, hpGrowth: 1.15, scaleStep: 0.06, scaleMax: 1.9, bossEvery: 5, maxAlive: 8, intermission: 5 },
        nightmare: { waves: 0, baseSpawns: 6, spawnGrowth: 3, hpGrowth: 1.22, scaleStep: 0.08, scaleMax: 2.4, bossEvery: 4, maxAlive: 12, intermission: 4 },
    },
    defaultPreset: "normal",
    bosses: [
        { id: "Troll_Forest", baseHp: 1400 },
        { id: "Dragon_GreenWelsh", baseHp: 2600 },
        { id: "Ranrak", baseHp: 3500 },
        { id: "Boss_Rookwood", baseHp: 2200 },
        { id: "Boss_Harlow", baseHp: 2200 },
        { id: "Boss_Cassandra", baseHp: 2000 },
        { id: "Boss_Solomon", baseHp: 2000 },
    ],
    hidden: [
        "ChompingCabbage", "VenomousTentacula", "LeapingToadstool", "Mandrake", "Flitterbloom",
        "IslaMacFusty", "DeathlyNightmare", "DeathlyDreamer", "Death",
    ],
    groups: [
        ["Goblin", "Goblins"], ["Poacher", "Poachers"], ["Extortionist", "Rookwood"],
        ["Thief", "Rookwood"], ["Wolf", "Beasts"], ["Spider", "Beasts"],
        ["Dugbog", "Beasts"], ["Troll", "Beasts"], ["Inferius", "Dark"],
        ["Mannequin", "Dark"], ["TombProtector", "Dark"], ["Death", "Dark"],
    ],
    arena: { ringRadius: 700, ringJitter: 220, baseEnemyHp: 200, intermissionDefault: 5 },
    players: { scaleFodder: true, perPlayerBonus: 0.75, maxPlayers: 8, lobbyTtlSeconds: 300 },
    interaction: {
        enabled: false,
        position: { x: 0, y: 0, z: 0 },
        areaId: "",
        regionId: "",
        radius: 300,
        promptDistance: 250,
        promptOffsetZ: 180,
        label: "Enter the Gauntlet",
        object: {
            model: "/Game/Environment/BanditCamps/CampA/Meshes/Props/SM_CampA_Brazier_A.SM_CampA_Brazier_A",
            collision: true,
        },
    },
};

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function finite(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function preset(value: unknown, fallback: DifficultyPreset): DifficultyPreset {
    const source = record(value) || {};
    return {
        waves: finite(source.waves, fallback.waves),
        baseSpawns: finite(source.baseSpawns, fallback.baseSpawns),
        spawnGrowth: finite(source.spawnGrowth, fallback.spawnGrowth),
        hpGrowth: finite(source.hpGrowth, fallback.hpGrowth),
        scaleStep: finite(source.scaleStep, fallback.scaleStep),
        scaleMax: finite(source.scaleMax, fallback.scaleMax),
        bossEvery: finite(source.bossEvery, fallback.bossEvery),
        maxAlive: finite(source.maxAlive, fallback.maxAlive),
        intermission: finite(source.intermission, fallback.intermission),
    };
}

function interaction(value: unknown): InteractionConfig {
    const source = record(value) || {};
    const position = record(source.position) || {};
    const object = record(source.object);
    return {
        ...DEFAULT_CONFIG.interaction,
        enabled: typeof source.enabled === "boolean" ? source.enabled : DEFAULT_CONFIG.interaction.enabled,
        position: {
            x: finite(position.x, DEFAULT_CONFIG.interaction.position.x),
            y: finite(position.y, DEFAULT_CONFIG.interaction.position.y),
            z: finite(position.z, DEFAULT_CONFIG.interaction.position.z),
        },
        areaId: typeof source.areaId === "string" ? source.areaId : DEFAULT_CONFIG.interaction.areaId,
        regionId: typeof source.regionId === "string" ? source.regionId : DEFAULT_CONFIG.interaction.regionId,
        radius: finite(source.radius, DEFAULT_CONFIG.interaction.radius),
        promptDistance: finite(source.promptDistance, DEFAULT_CONFIG.interaction.promptDistance),
        promptOffsetZ: finite(source.promptOffsetZ, DEFAULT_CONFIG.interaction.promptOffsetZ),
        label: typeof source.label === "string" && source.label.trim() ? source.label.trim() : DEFAULT_CONFIG.interaction.label,
        object: object ? {
            model: typeof object.model === "string" || typeof object.model === "number"
                ? object.model
                : DEFAULT_CONFIG.interaction.object!.model,
            pitch: finite(object.pitch, 0),
            yaw: finite(object.yaw, 0),
            roll: finite(object.roll, 0),
            scale: finite(object.scale, 1),
            collision: typeof object.collision === "boolean" ? object.collision : true,
        } : DEFAULT_CONFIG.interaction.object,
    };
}

/** Normalize an optional data/hmp-gauntlet.json override without trusting its runtime shape. */
export function normalizeConfig(value: unknown): GauntletConfig {
    const source = record(value) || {};
    const sourcePresets = record(source.presets) || {};
    const presets: Record<string, DifficultyPreset> = {};
    for (const [name, fallback] of Object.entries(DEFAULT_CONFIG.presets)) {
        presets[name] = preset(sourcePresets[name], fallback);
    }
    for (const [name, candidate] of Object.entries(sourcePresets)) {
        if (!presets[name] && record(candidate)) presets[name] = preset(candidate, DEFAULT_CONFIG.presets.normal);
    }

    const sourceArena = record(source.arena) || {};
    const sourcePlayers = record(source.players) || {};
    const bosses = Array.isArray(source.bosses)
        ? source.bosses.flatMap((entry) => {
            const item = record(entry);
            return item && typeof item.id === "string" && item.id.trim()
                ? [{ id: item.id.trim(), baseHp: Math.max(1, finite(item.baseHp, 2000)) }]
                : [];
        })
        : DEFAULT_CONFIG.bosses.map((entry) => ({ ...entry }));
    const groups = Array.isArray(source.groups)
        ? source.groups.flatMap((entry) => Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string"
            ? [[entry[0], entry[1]] as [string, string]]
            : [])
        : DEFAULT_CONFIG.groups.map(([prefix, label]): [string, string] => [prefix, label]);
    const hidden = Array.isArray(source.hidden)
        ? source.hidden.filter((entry): entry is string => typeof entry === "string")
        : [...DEFAULT_CONFIG.hidden];
    const requestedDefault = typeof source.defaultPreset === "string" ? source.defaultPreset : DEFAULT_CONFIG.defaultPreset;

    return {
        presets,
        defaultPreset: presets[requestedDefault] ? requestedDefault : DEFAULT_CONFIG.defaultPreset,
        bosses,
        hidden,
        groups,
        arena: {
            ringRadius: finite(sourceArena.ringRadius, DEFAULT_CONFIG.arena.ringRadius),
            ringJitter: finite(sourceArena.ringJitter, DEFAULT_CONFIG.arena.ringJitter),
            baseEnemyHp: finite(sourceArena.baseEnemyHp, DEFAULT_CONFIG.arena.baseEnemyHp),
            intermissionDefault: finite(sourceArena.intermissionDefault, DEFAULT_CONFIG.arena.intermissionDefault),
        },
        players: {
            scaleFodder: typeof sourcePlayers.scaleFodder === "boolean" ? sourcePlayers.scaleFodder : DEFAULT_CONFIG.players.scaleFodder,
            perPlayerBonus: finite(sourcePlayers.perPlayerBonus, DEFAULT_CONFIG.players.perPlayerBonus),
            maxPlayers: finite(sourcePlayers.maxPlayers, DEFAULT_CONFIG.players.maxPlayers),
            lobbyTtlSeconds: finite(sourcePlayers.lobbyTtlSeconds, DEFAULT_CONFIG.players.lobbyTtlSeconds),
        },
        interaction: interaction(source.interaction),
    };
}
