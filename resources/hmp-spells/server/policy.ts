import catalogModule = require("../shared/catalog");
import type { HmpResolvedSpellPolicy, HmpSpellEntitlements, HmpSpellRule } from "../types";
import type { EffectiveGroups } from "./internal";

const { SPELLS } = catalogModule;
const ALL_LOCKS = [...new Set(SPELLS.map((spell) => spell.lockId))];

function applies(rule: HmpSpellRule, groups: EffectiveGroups): boolean {
    if (!rule.match) return true;
    const membership = new Map(groups.map((group) => [group.key.toLowerCase(), Number(group.grade) || 0]));
    const checks = rule.match.groups.map((required) => (membership.get(required.key.toLowerCase()) ?? Number.NEGATIVE_INFINITY) >= (required.minimumGrade || 0));
    return rule.match.groupMode === "all" ? checks.every(Boolean) : checks.some(Boolean);
}

function verdict(rules: HmpSpellRule[]): "allow" | "deny" | null {
    if (!rules.length) return null;
    const priority = Math.min(...rules.map((rule) => rule.priority));
    const strongest = rules.filter((rule) => rule.priority === priority);
    return strongest.some((rule) => rule.action === "deny") ? "deny" : "allow";
}

function evaluateRules(rules: ReadonlyArray<HmpSpellRule>, groups: EffectiveGroups, entitlements: HmpSpellEntitlements): HmpResolvedSpellPolicy {
    const applicable = rules.filter((rule) => applies(rule, groups));
    const spellRules = applicable.filter((rule) => rule.spells !== undefined);
    const candidates = new Set<string>();
    if (spellRules.some((rule) => rule.spells === "*")) for (const lockId of ALL_LOCKS) candidates.add(lockId);
    for (const rule of spellRules) if (Array.isArray(rule.spells)) for (const lockId of rule.spells) candidates.add(lockId);
    const unlockSpells = [...candidates].filter((lockId) => verdict(spellRules.filter((rule) => rule.spells === "*" || (Array.isArray(rule.spells) && rule.spells.includes(lockId)))) === "allow");
    for (const lockId of entitlements.spells) if (!unlockSpells.includes(lockId)) unlockSpells.push(lockId);
    const ruleLoadouts = applicable.filter((rule) => rule.action === "allow" && rule.bonusLoadouts !== undefined).map((rule) => rule.bonusLoadouts as number);
    // A native unlock sticks, so an unallowed spell has to be named to be taken back. Deriving the
    // revoke list from the catalog rather than from stored history keeps `deny` honest for a spell
    // already in hand, and makes the policy reproduce the fresh-character lock table plus the grants.
    const allowed = new Set(unlockSpells);
    return {
        unlockSpells: unlockSpells.sort(),
        bonusLoadouts: entitlements.bonusLoadouts === null ? (ruleLoadouts.length ? Math.max(...ruleLoadouts) : null) : entitlements.bonusLoadouts,
        lockSpells: ALL_LOCKS.filter((lockId) => !allowed.has(lockId)).sort(),
    };
}

export = { applies, verdict, evaluateRules, ALL_LOCKS };
