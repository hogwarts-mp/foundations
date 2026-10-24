import catalogModule = require("../shared/catalog");
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpDefinedSpell, HmpSpellPlayer, HmpSpellRule } from "../types";
import type { SpellConfig } from "./internal";

const { createCatalog, resolveSpell } = catalogModule;

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

function normalizeRule(raw: unknown, index: number, defaultResource = "hmp-spells", resolve = resolveSpell): HmpSpellRule {
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
                const resolved = resolve(String(spell));
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

// Shape only: the host owns the rest (a real base, stat and part names, text limits) and throws on it.
function normalizeDefinition(raw: unknown, label: string, resource: string): HmpDefinedSpell {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`${label} must be an object`);
    const value = raw as Record<string, unknown>;
    const id = String(value.id || "").trim();
    if (!/^[A-Za-z][A-Za-z0-9_]{2,31}$/.test(id)) throw new TypeError(`${label} id must be 3-32 characters: a letter, then letters, digits or _`);
    // A game name (Bombarda is Spell_Expulso) or a raw lock id would resolve to another spell's lock.
    if (resolveSpell(id)) throw new TypeError(`${label} id '${id}' already names a spell`);
    const definition: HmpDefinedSpell = { id, resource: cleanId(resource, `${label} resource`), base: cleanId(value.base, `${label} base`) };
    for (const key of ["name", "description", "icon", "incantation"] as const) {
        if (value[key] === undefined) continue;
        if (typeof value[key] !== "string") throw new TypeError(`${label} ${key} must be a string`);
        definition[key] = value[key];
    }
    for (const [key, type] of [["stats", "number"], ["parts", "string"]] as const) {
        if (value[key] === undefined) continue;
        const entries = value[key];
        if (!entries || typeof entries !== "object" || Array.isArray(entries)
            || !Object.values(entries).every((entry) => typeof entry === type && (type === "string" || Number.isFinite(entry)))) {
            throw new TypeError(`${label} ${key} must be an object of ${type === "number" ? "finite numbers" : "spell names"}`);
        }
        definition[key] = { ...entries };
    }
    return definition;
}

function loadConfig(Hmp: HmpLibServer<HmpSpellPlayer>, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): SpellConfig {
    const env = options.env || process.env;
    const defaults: SpellConfig = {
        command: "spells",
        enableCommands: true,
        adminGroups: [{ key: "admin", minimumGrade: 1 }],
        rules: [FREERIDE_BASELINE],
        definitions: [],
        maxCastReportsPerSecond: 12,
    };
    const loaded = Hmp.config.load<SpellConfig & Record<string, unknown>>(env.HMP_SPELLS_CONFIG || "data/hmp-spells.json", {
        cwd: options.cwd || process.cwd(), defaults: defaults as SpellConfig & Record<string, unknown>,
    });
    if (!Array.isArray(loaded.rules)) throw new TypeError("hmp-spells rules must be an array");
    if (!Array.isArray(loaded.adminGroups)) throw new TypeError("hmp-spells adminGroups must be an array");
    if (!Array.isArray(loaded.definitions)) throw new TypeError("hmp-spells definitions must be an array");
    const definitions = loaded.definitions.map((definition, index) => normalizeDefinition(definition, `hmp-spells definition ${index}`, "hmp-spells"));
    const ids = definitions.map((definition) => definition.id.toLowerCase());
    if (new Set(ids).size !== ids.length) throw new TypeError("hmp-spells definitions has duplicate ids");
    // Rules may name a configured spell by id before the host defines it; on a host without
    // Spells.define its Spell_<id> lock is simply never used.
    const known = createCatalog(() => definitions.map((definition) => ({ name: definition.id, lockId: `Spell_${definition.id}` })));
    const adminGroups = loaded.adminGroups.map((entry, index) => ({
        key: cleanId(entry?.key, `admin group ${index} key`).toLowerCase(),
        minimumGrade: Number.isSafeInteger(Number(entry?.minimumGrade)) ? Number(entry.minimumGrade) : 0,
    }));
    const maxCastReportsPerSecond = Math.max(1, Math.min(60, Math.floor(Number(loaded.maxCastReportsPerSecond) || 12)));
    // config.load replaces arrays wholesale, so an owner stating `rules` drops the baseline entirely.
    // Restore it rather than exempt it: a rule of the same id replaces it, and any deny at priority
    // 900 or stronger still beats it, so denying Protego for a wandless minigame keeps working.
    const rules = loaded.rules.map((rule, index) => normalizeRule(rule, index, "hmp-spells", known.resolve));
    if (!rules.some((rule) => rule.id === FREERIDE_BASELINE.id)) rules.unshift(normalizeRule(FREERIDE_BASELINE, 0));
    return {
        command: cleanId(env.HMP_SPELLS_COMMAND || loaded.command || "spells", "hmp-spells command").toLowerCase(),
        enableCommands: env.HMP_SPELLS_COMMANDS === undefined ? loaded.enableCommands !== false : Hmp.config.env.boolean(env.HMP_SPELLS_COMMANDS, true),
        adminGroups,
        rules,
        definitions,
        maxCastReportsPerSecond,
    };
}

export = { loadConfig, normalizeDefinition, normalizeRule };
