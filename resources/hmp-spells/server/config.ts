import catalogModule = require("../shared/catalog");
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpSpellPlayer, HmpSpellRule } from "../types";
import type { SpellConfig } from "./internal";

const { resolveSpell } = catalogModule;

function cleanId(value: unknown, label: string, maximum = 100): string {
    const result = String(value || "").trim();
    if (!result || result.length > maximum) throw new TypeError(`${label} must be a non-empty string up to ${maximum} characters`);
    return result;
}

function normalizeGroups(raw: unknown, label: string) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`${label} must be an object`);
    const match = raw as Record<string, unknown>;
    if (!Array.isArray(match.groups) || !match.groups.length) throw new TypeError(`${label}.groups must be a non-empty array`);
    const groups = match.groups.map((rawGroup, index) => {
        if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) throw new TypeError(`${label}.groups[${index}] must be an object`);
        const group = rawGroup as Record<string, unknown>;
        const minimumGrade = group.minimumGrade === undefined ? 0 : Number(group.minimumGrade);
        if (!Number.isSafeInteger(minimumGrade)) throw new TypeError(`${label}.groups[${index}].minimumGrade must be an integer`);
        return { key: cleanId(group.key, `${label}.groups[${index}].key`).toLowerCase(), minimumGrade };
    });
    if (match.groupMode !== undefined && match.groupMode !== "any" && match.groupMode !== "all") throw new TypeError(`${label}.groupMode must be any or all`);
    return { groups, groupMode: match.groupMode === "all" ? "all" as const : "any" as const };
}

// Protego/Stupefy are the only Spell_* locks open on a fresh character, and AimMode is opened by the
// client's freeride boot. The policy owns the whole lock table, so leaving them unstated revokes them.
const FREERIDE_BASELINE: HmpSpellRule = { id: "freeride-baseline", resource: "hmp-spells", priority: 900, action: "allow", spells: ["Spell_Protego", "Spell_Stupefy", "Spell_AimMode"] };

function normalizeRule(raw: unknown, index: number, defaultResource = "hmp-spells"): HmpSpellRule {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`hmp-spells rule ${index} must be an object`);
    const value = raw as Record<string, unknown>;
    const resource = cleanId(value.resource || defaultResource, `rule ${index} resource`);
    const id = cleanId(value.id || `config-${index + 1}`, `rule ${index} id`);
    const priority = Number(value.priority);
    if (!Number.isFinite(priority)) throw new TypeError(`hmp-spells rule ${index} priority must be finite`);
    if (value.action !== "allow" && value.action !== "deny") throw new TypeError(`hmp-spells rule ${index} action must be allow or deny`);
    if (value.spells === undefined && value.bonusLoadouts === undefined) throw new TypeError(`hmp-spells rule ${index} must define spells or bonusLoadouts`);
    const rule: HmpSpellRule = { id, resource, priority, action: value.action };
    if (value.spells !== undefined) {
        if (value.spells === "*") rule.spells = "*";
        else {
            if (!Array.isArray(value.spells) || !value.spells.length) throw new TypeError(`hmp-spells rule ${index} spells must be '*' or a non-empty array`);
            const spells = value.spells.map((spell) => {
                const resolved = resolveSpell(String(spell));
                if (!resolved) throw new TypeError(`hmp-spells rule ${index} contains unknown spell '${String(spell)}'`);
                return resolved;
            });
            rule.spells = [...new Set(spells)];
        }
    }
    if (value.bonusLoadouts !== undefined) {
        if (value.action !== "allow") throw new TypeError(`hmp-spells rule ${index} bonusLoadouts is only valid on allow rules`);
        const count = Number(value.bonusLoadouts);
        if (!Number.isSafeInteger(count) || count < 0 || count > 3) throw new TypeError(`hmp-spells rule ${index} bonusLoadouts must be an integer from 0 to 3`);
        rule.bonusLoadouts = count;
    }
    if (value.match !== undefined) rule.match = normalizeGroups(value.match, `hmp-spells rule ${index} match`);
    return rule;
}

function loadConfig(Hmp: HmpLibServer<HmpSpellPlayer>, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): SpellConfig {
    const env = options.env || process.env;
    const defaults: SpellConfig = {
        command: "spells",
        enableCommands: true,
        adminGroups: [{ key: "admin", minimumGrade: 1 }],
        rules: [FREERIDE_BASELINE],
        maxCastReportsPerSecond: 12,
    };
    const loaded = Hmp.config.load<SpellConfig & Record<string, unknown>>(env.HMP_SPELLS_CONFIG || "data/hmp-spells.json", {
        cwd: options.cwd || process.cwd(), defaults: defaults as SpellConfig & Record<string, unknown>,
    });
    if (!Array.isArray(loaded.rules)) throw new TypeError("hmp-spells rules must be an array");
    if (!Array.isArray(loaded.adminGroups)) throw new TypeError("hmp-spells adminGroups must be an array");
    const adminGroups = loaded.adminGroups.map((entry, index) => ({
        key: cleanId(entry?.key, `admin group ${index} key`).toLowerCase(),
        minimumGrade: Number.isSafeInteger(Number(entry?.minimumGrade)) ? Number(entry.minimumGrade) : 0,
    }));
    const maxCastReportsPerSecond = Math.max(1, Math.min(60, Math.floor(Number(loaded.maxCastReportsPerSecond) || 12)));
    // config.load replaces arrays wholesale, so an owner stating `rules` drops the baseline entirely.
    // Restore it rather than exempt it: a rule of the same id replaces it, and any deny at priority
    // 900 or stronger still beats it, so denying Protego for a wandless minigame keeps working.
    const rules = loaded.rules.map((rule, index) => normalizeRule(rule, index));
    if (!rules.some((rule) => rule.id === FREERIDE_BASELINE.id)) rules.unshift(normalizeRule(FREERIDE_BASELINE, 0));
    return {
        command: cleanId(env.HMP_SPELLS_COMMAND || loaded.command || "spells", "hmp-spells command").toLowerCase(),
        enableCommands: env.HMP_SPELLS_COMMANDS === undefined ? loaded.enableCommands !== false : Hmp.config.env.boolean(env.HMP_SPELLS_COMMANDS, true),
        adminGroups,
        rules,
        maxCastReportsPerSecond,
    };
}

export = { loadConfig, normalizeRule };
