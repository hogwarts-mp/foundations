import type { HmpDoorRule, HmpResolvedDoorPolicy } from "../types";
import type { EffectiveGroups } from "./internal";

function applies(rule: HmpDoorRule, groups: EffectiveGroups): boolean {
    if (!rule.match) return true;
    const membership = new Map(groups.map((group) => [group.key.toLowerCase(), Number(group.grade) || 0]));
    const checks = rule.match.groups.map((required) => (membership.get(required.key.toLowerCase()) ?? Number.NEGATIVE_INFINITY) >= (required.minimumGrade || 0));
    return rule.match.groupMode === "all" ? checks.every(Boolean) : checks.some(Boolean);
}

function verdict(rules: HmpDoorRule[]): "allow" | "deny" | "lock" | null {
    if (!rules.length) return null;
    const priority = Math.min(...rules.map((rule) => rule.priority));
    const strongest = rules.filter((rule) => rule.priority === priority);
    if (strongest.some((rule) => rule.action === "lock")) return "lock";
    return strongest.some((rule) => rule.action === "deny") ? "deny" : "allow";
}

function evaluateRules(rules: ReadonlyArray<HmpDoorRule>, groups: EffectiveGroups, grants: ReadonlyArray<string> = []): HmpResolvedDoorPolicy {
    const applicable = rules.filter((rule) => applies(rule, groups));
    const doorRules = applicable.filter((rule) => rule.doors !== undefined);
    const lockRules = applicable.filter((rule) => rule.locks !== undefined);
    const alohomoraRules = applicable.filter((rule) => rule.alohomora === true);
    const wildcardAllow = verdict(doorRules.filter((rule) => rule.doors === "*")) === "allow";
    const namedDoors = new Set<string>();
    for (const rule of doorRules) if (Array.isArray(rule.doors)) for (const name of rule.doors) namedDoors.add(name);
    const unlockDoors: string[] = [];
    const unlockAllExcept: string[] = [];
    const lockDoors: string[] = [];
    for (const name of namedDoors) {
        const decision = verdict(doorRules.filter((rule) => rule.doors === "*" || (Array.isArray(rule.doors) && rule.doors.includes(name))));
        if (decision === "lock") {
            lockDoors.push(name);
            // Also an unlock exception: a client too old to honour lockDoors then leaves the door alone
            // rather than unlocking it under a wildcard allow.
            if (wildcardAllow) unlockAllExcept.push(name);
        }
        else if (decision === "allow") unlockDoors.push(name);
        else if (decision === "deny" && wildcardAllow) unlockAllExcept.push(name);
    }
    const lockIds = new Set<string>();
    for (const rule of lockRules) for (const id of rule.locks || []) lockIds.add(id);
    const unlockLocks = [...lockIds].filter((id) => verdict(lockRules.filter((rule) => rule.locks?.includes(id))) === "allow");
    // A grant is a per-character exception, so it outranks a lock as well as a deny.
    for (const name of grants) {
        if (!unlockDoors.includes(name)) unlockDoors.push(name);
        const denied = unlockAllExcept.indexOf(name);
        if (denied >= 0) unlockAllExcept.splice(denied, 1);
        const locked = lockDoors.indexOf(name);
        if (locked >= 0) lockDoors.splice(locked, 1);
    }
    return {
        unlockAll: wildcardAllow,
        unlockDoors: unlockDoors.sort(),
        unlockAllExcept: unlockAllExcept.sort(),
        lockDoors: lockDoors.sort(),
        unlockLocks: unlockLocks.sort(),
        superAlohomora: verdict(alohomoraRules) === "allow",
    };
}

/**
 * The level each selector's padlocks are held at. The server holds one for every player, so match plays no part:
 * the strongest rule carrying a level for a selector wins it, and at equal priority the higher level does.
 */
function lockLevels(rules: ReadonlyArray<HmpDoorRule>): Map<string, 1 | 2 | 3> {
    const chosen = new Map<string, { priority: number; level: 1 | 2 | 3 }>();
    for (const rule of rules) {
        if (!rule.lockLevel || !Array.isArray(rule.doors)) continue;
        for (const selector of rule.doors) {
            const current = chosen.get(selector);
            if (!current || rule.priority < current.priority || (rule.priority === current.priority && rule.lockLevel > current.level)) {
                chosen.set(selector, { priority: rule.priority, level: rule.lockLevel });
            }
        }
    }
    return new Map([...chosen].map(([selector, held]) => [selector, held.level]));
}

export = { applies, verdict, evaluateRules, lockLevels };
