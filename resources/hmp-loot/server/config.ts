import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpLootDefinition, HmpLootFamilies, HmpLootItem, HmpLootPlayer } from "../types";
import type { LootConfig } from "./internal";

const KINDS = new Set(["chest", "moonstone", "foragable"]);
const SCOPES = new Set(["character", "shared"]);
const KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

function cleanId(value: unknown, label: string): string {
    const result = String(value || "").trim();
    if (!result || result.length > 64) throw new TypeError(`${label} must be a non-empty string up to 64 characters`);
    return result;
}

function finite(value: unknown, label: string): number {
    const n = Number(value);
    if (typeof value !== "number" || !Number.isFinite(n)) throw new TypeError(`${label} must be a number`);
    return n;
}

function positiveInt(value: unknown, label: string): number {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(`${label} must be a positive integer`);
    return n;
}

function families(value: unknown, label: string): HmpLootFamilies {
    const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const out = { chests: false, moonstones: false, foragables: false };
    for (const family of Object.keys(out) as Array<keyof HmpLootFamilies>) {
        if (raw[family] === undefined) continue;
        if (typeof raw[family] !== "boolean") throw new TypeError(`${label}.${family} must be a boolean`);
        out[family] = raw[family] as boolean;
    }
    return out;
}

function items(value: unknown, label: string): HmpLootItem[] {
    if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of { itemId, count? }`);
    return value.map((entry, index) => {
        if (!entry || typeof entry !== "object") throw new TypeError(`${label}[${index}] must be an object`);
        const item = entry as Record<string, unknown>;
        return { itemId: cleanId(item.itemId, `${label}[${index}].itemId`), count: item.count === undefined ? 1 : positiveInt(item.count, `${label}[${index}].count`) };
    });
}

function definition(value: unknown, index: number): HmpLootDefinition {
    const label = `hmp-loot lootables[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
    const raw = value as Record<string, unknown>;
    const key = String(raw.key ?? "");
    if (!KEY_PATTERN.test(key)) throw new TypeError(`${label}.key must be 1-64 letters, digits, '_', '.' or '-'`);
    const kind = String(raw.kind ?? "chest");
    if (!KINDS.has(kind)) throw new TypeError(`${label}.kind must be "chest", "moonstone" or "foragable"`);
    const scope = String(raw.scope ?? "character");
    if (!SCOPES.has(scope)) throw new TypeError(`${label}.scope must be "character" or "shared"`);
    const position = raw.position && typeof raw.position === "object" ? raw.position as Record<string, unknown> : null;
    if (!position) throw new TypeError(`${label}.position must be { x, y, z }`);
    const out: HmpLootDefinition = {
        key,
        kind: kind as HmpLootDefinition["kind"],
        position: { x: finite(position.x, `${label}.position.x`), y: finite(position.y, `${label}.position.y`), z: finite(position.z, `${label}.position.z`) },
        yaw: raw.yaw === undefined ? 0 : finite(raw.yaw, `${label}.yaw`),
        items: items(raw.items ?? [], `${label}.items`),
        scope: scope as HmpLootDefinition["scope"],
        respawnSeconds: raw.respawnSeconds === undefined || raw.respawnSeconds === null ? null : positiveInt(raw.respawnSeconds, `${label}.respawnSeconds`),
    };
    if (raw.model !== undefined) out.model = cleanId(raw.model, `${label}.model`).slice(0, 256);
    return out;
}

function loadConfig(Hmp: HmpLibServer<HmpLootPlayer>, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): LootConfig {
    const env = options.env || process.env;
    const defaults: LootConfig = {
        command: "loot",
        enableCommands: true,
        adminGroups: [{ key: "admin", minimumGrade: 1 }],
        suppressGameLoot: { chests: false, moonstones: false, foragables: false },
        lootables: [],
        sweepMs: 1000,
    };
    const loaded = Hmp.config.load<LootConfig & Record<string, unknown>>(env.HMP_LOOT_CONFIG || "data/hmp-loot.json", {
        cwd: options.cwd || process.cwd(),
        defaults: defaults as LootConfig & Record<string, unknown>,
    });
    const command = cleanId(env.HMP_LOOT_COMMAND || loaded.command || "loot", "hmp-loot command").toLowerCase();
    const enableCommands = env.HMP_LOOT_COMMANDS === undefined ? loaded.enableCommands !== false : Hmp.config.env.boolean(env.HMP_LOOT_COMMANDS, true);
    if (!Array.isArray(loaded.adminGroups)) throw new TypeError("hmp-loot adminGroups must be an array");
    const adminGroups = loaded.adminGroups.map((entry, index) => ({
        key: cleanId(entry?.key, `admin group ${index} key`).toLowerCase(),
        minimumGrade: Number.isSafeInteger(Number(entry?.minimumGrade)) ? Number(entry.minimumGrade) : 0,
    }));
    if (!Array.isArray(loaded.lootables)) throw new TypeError("hmp-loot lootables must be an array");
    const lootables = loaded.lootables.map(definition);
    const seen = new Set<string>();
    for (const entry of lootables) {
        if (seen.has(entry.key)) throw new TypeError(`hmp-loot lootable key '${entry.key}' is used twice`);
        seen.add(entry.key);
    }
    const sweepMs = loaded.sweepMs === undefined ? defaults.sweepMs : positiveInt(loaded.sweepMs, "hmp-loot sweepMs");
    return { command, enableCommands, adminGroups, suppressGameLoot: families(loaded.suppressGameLoot, "hmp-loot suppressGameLoot"), lootables, sweepMs };
}

export = { loadConfig };
