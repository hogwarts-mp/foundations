import type { HmpLibServer } from "../../hmp-lib/types";
import type { CharacterConfig, Player, StartingGearEntry } from "./internal";

const DEFAULT_STARTING_GEAR: ReadonlyArray<StartingGearEntry> = Object.freeze([
    { itemId: "Head_034_Basic", identified: true, equipped: false },
    { itemId: "Neck_043_Basic", identified: true, equipped: false },
    { itemId: "Hand_007_Basic", identified: true, equipped: false },
    { itemId: "Face_005_Basic", identified: true, equipped: false },
]);

function normalizeStartingGear(raw: unknown): StartingGearEntry[] {
    const source = Array.isArray(raw) ? raw : DEFAULT_STARTING_GEAR;
    const entries: StartingGearEntry[] = [];
    for (const candidate of source) {
        if (!candidate || typeof candidate !== "object") continue;
        const value = candidate as Record<string, unknown>;
        const itemId = String(value.itemId || "").trim().slice(0, 96);
        if (!itemId) continue;
        const entry: StartingGearEntry = { itemId };
        const count = Math.trunc(Number(value.count));
        if (value.count !== undefined && Number.isSafeInteger(count) && count > 0) entry.count = count;
        if (value.variation !== undefined && value.variation !== null && String(value.variation)) entry.variation = String(value.variation).slice(0, 96);
        for (const key of ["identified", "equipped", "hoodUp", "unique"] as const) {
            if (typeof value[key] === "boolean") entry[key] = value[key];
        }
        entries.push(entry);
    }
    return entries;
}

function loadConfig(Hmp: HmpLibServer<Player>, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): CharacterConfig {
    const env = options.env || process.env;
    const cwd = options.cwd || process.cwd();
    const defaults: CharacterConfig = {
        autoOpenOnJoin: true,
        allowDelete: true,
        allowCloseWithActiveCharacter: true,
        command: "characters",
        appearanceTimeoutMs: 6000,
        startingGear: DEFAULT_STARTING_GEAR.map((entry) => ({ ...entry })),
        title: "Choose Your Wizard",
        subtitle: "Every story begins with a name.",
    };
    const config = Hmp.config.load<CharacterConfig>(env.HMP_CHARACTERS_CONFIG || "data/hmp-characters.json", { cwd, defaults });
    if (env.HMP_CHARACTERS_AUTO_OPEN) config.autoOpenOnJoin = Hmp.config.env.boolean(env.HMP_CHARACTERS_AUTO_OPEN);
    if (env.HMP_CHARACTERS_ALLOW_DELETE) config.allowDelete = Hmp.config.env.boolean(env.HMP_CHARACTERS_ALLOW_DELETE);
    if (env.HMP_CHARACTERS_COMMAND) config.command = String(env.HMP_CHARACTERS_COMMAND).trim().toLowerCase();
    config.appearanceTimeoutMs = Math.max(500, Math.min(15000, Math.trunc(Number(config.appearanceTimeoutMs)) || 6000));
    config.startingGear = normalizeStartingGear(config.startingGear);
    return config;
}

export = { DEFAULT_STARTING_GEAR, loadConfig, normalizeStartingGear };
// TypeScript source.
