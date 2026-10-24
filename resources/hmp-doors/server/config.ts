import gatesModule = require("../shared/gates");
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpDoorHeldGate, HmpDoorPlayer, HmpDoorRule } from "../types";
import type { DoorConfig } from "./internal";

const { GATE_KINDS, isGateKind } = gatesModule;

function cleanId(value: unknown, label: string): string {
    const result = String(value || "").trim();
    if (!result || result.length > 200) throw new TypeError(`${label} must be a non-empty string up to 200 characters`);
    return result;
}

function normalizeRule(raw: unknown, index: number): HmpDoorRule {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError(`hmp-doors rule ${index} must be an object`);
    const value = raw as Record<string, unknown>;
    const priority = Number(value.priority);
    if (!Number.isFinite(priority)) throw new TypeError(`hmp-doors rule ${index} priority must be finite`);
    if (value.action !== "allow" && value.action !== "deny" && value.action !== "lock") throw new TypeError(`hmp-doors rule ${index} action must be allow, deny or lock`);
    const targets = [value.doors !== undefined, value.gates !== undefined, value.locks !== undefined, value.alohomora === true].filter(Boolean).length;
    if (targets !== 1) throw new TypeError(`hmp-doors rule ${index} must target exactly one of doors, gates, locks, or alohomora`);
    // A logical lock is already locked by not being unlocked, and locking every door or gate needs a native
    // that does not exist, so 'lock' is rejected rather than silently doing nothing for those shapes.
    if (value.action === "lock" && value.doors === undefined && value.gates === undefined) throw new TypeError(`hmp-doors rule ${index} action lock applies only to a doors or gates target`);
    if (value.action === "lock" && (value.doors === "*" || value.gates === "*")) throw new TypeError(`hmp-doors rule ${index} action lock needs explicit doors or gates, not '*'`);
    const rule: HmpDoorRule = { priority, action: value.action };
    if (value.doors !== undefined) {
        if (value.doors === "*") rule.doors = "*";
        else if (Array.isArray(value.doors) && value.doors.length) rule.doors = [...new Set(value.doors.map((entry) => cleanId(entry, `rule ${index} door`)))];
        else throw new TypeError(`hmp-doors rule ${index} doors must be '*' or a non-empty array`);
    }
    if (value.gates !== undefined) {
        if (value.gates === "*") rule.gates = "*";
        else if (Array.isArray(value.gates) && value.gates.length) rule.gates = [...new Set(value.gates.map((entry) => cleanId(entry, `rule ${index} gate`)))];
        else throw new TypeError(`hmp-doors rule ${index} gates must be '*' or a non-empty array`);
    }
    if (value.kind !== undefined) {
        // A rule naming gates applies to them whatever their kind, so a kind only narrows the wildcard.
        if (value.gates !== "*") throw new TypeError(`hmp-doors rule ${index} kind applies only to a gates '*' rule`);
        const kinds = Array.isArray(value.kind) ? value.kind : [value.kind];
        if (!kinds.length || !kinds.every(isGateKind)) throw new TypeError(`hmp-doors rule ${index} kind must be ${GATE_KINDS.join(", ")} or an array of them`);
        rule.kind = [...new Set(kinds)];
    }
    if (value.open !== undefined) {
        if (value.open !== true || value.action !== "allow" || value.gates === undefined) throw new TypeError(`hmp-doors rule ${index} open must be true, on an allow rule targeting gates`);
        rule.open = true;
    }
    if (value.locks !== undefined) {
        if (!Array.isArray(value.locks) || !value.locks.length) throw new TypeError(`hmp-doors rule ${index} locks must be a non-empty array`);
        rule.locks = [...new Set(value.locks.map((entry) => cleanId(entry, `rule ${index} lock`)))];
    }
    if (value.alohomora === true) rule.alohomora = true;
    if (value.lockLevel !== undefined) {
        if (value.lockLevel !== 1 && value.lockLevel !== 2 && value.lockLevel !== 3) throw new TypeError(`hmp-doors rule ${index} lockLevel must be 1, 2 or 3`);
        // The server holds one level per selector for every player, so it can follow neither an unlock, the
        // wildcard, nor a per-player match.
        if (value.action === "allow" || !Array.isArray(value.doors)) throw new TypeError(`hmp-doors rule ${index} lockLevel applies only to a deny or lock rule naming doors`);
        if (value.match !== undefined) throw new TypeError(`hmp-doors rule ${index} lockLevel is held for every player, so it cannot carry match`);
        rule.lockLevel = value.lockLevel;
    }
    if (value.match !== undefined) {
        if (!value.match || typeof value.match !== "object" || Array.isArray(value.match)) throw new TypeError(`hmp-doors rule ${index} match must be an object`);
        const match = value.match as Record<string, unknown>;
        if (!Array.isArray(match.groups) || !match.groups.length) throw new TypeError(`hmp-doors rule ${index} match.groups must be a non-empty array`);
        const groups = match.groups.map((rawGroup, groupIndex) => {
            if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) throw new TypeError(`rule ${index} group ${groupIndex} must be an object`);
            const group = rawGroup as Record<string, unknown>;
            const minimumGrade = group.minimumGrade === undefined ? 0 : Number(group.minimumGrade);
            if (!Number.isSafeInteger(minimumGrade)) throw new TypeError(`rule ${index} group ${groupIndex} minimumGrade must be an integer`);
            return { key: cleanId(group.key, `rule ${index} group ${groupIndex} key`).toLowerCase(), minimumGrade };
        });
        if (match.groupMode !== undefined && match.groupMode !== "any" && match.groupMode !== "all") throw new TypeError(`hmp-doors rule ${index} groupMode must be any or all`);
        rule.match = { groups, groupMode: match.groupMode === "all" ? "all" : "any" };
    }
    return rule;
}

function normalizeHeldGates(raw: unknown): Record<string, HmpDoorHeldGate> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("hmp-doors heldGates must be an object");
    const held: Record<string, HmpDoorHeldGate> = {};
    for (const [rawSelector, rawState] of Object.entries(raw)) {
        const selector = cleanId(rawSelector, "hmp-doors heldGates selector");
        const state = rawState && typeof rawState === "object" && !Array.isArray(rawState) ? rawState as Record<string, unknown> : null;
        if (!state || (state.locked === undefined && state.open === undefined)) throw new TypeError(`hmp-doors heldGates '${selector}' must hold locked, open, or both`);
        const gate: HmpDoorHeldGate = {};
        for (const axis of ["locked", "open"] as const) {
            if (state[axis] === undefined) continue;
            if (typeof state[axis] !== "boolean") throw new TypeError(`hmp-doors heldGates '${selector}' ${axis} must be a boolean`);
            gate[axis] = state[axis];
        }
        held[selector] = gate;
    }
    return held;
}

function loadConfig(Hmp: HmpLibServer<HmpDoorPlayer>, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): DoorConfig {
    const env = options.env || process.env;
    const defaults: DoorConfig = {
        command: "doors",
        enableCommands: true,
        adminGroups: [{ key: "admin", minimumGrade: 1 }],
        shareUnlocks: false,
        gateSchedule: "local",
        heldGates: {},
        rules: [{ priority: 1000, action: "allow", doors: "*" }],
    };
    const loaded = Hmp.config.load<DoorConfig & Record<string, unknown>>(env.HMP_DOORS_CONFIG || "data/hmp-doors.json", {
        cwd: options.cwd || process.cwd(),
        defaults: defaults as DoorConfig & Record<string, unknown>,
    });
    const command = cleanId(env.HMP_DOORS_COMMAND || loaded.command || "doors", "hmp-doors command").toLowerCase();
    const enableCommands = env.HMP_DOORS_COMMANDS === undefined ? loaded.enableCommands !== false : Hmp.config.env.boolean(env.HMP_DOORS_COMMANDS, true);
    if (!Array.isArray(loaded.rules)) throw new TypeError("hmp-doors rules must be an array");
    if (!Array.isArray(loaded.adminGroups)) throw new TypeError("hmp-doors adminGroups must be an array");
    if (typeof loaded.shareUnlocks !== "boolean") throw new TypeError("hmp-doors shareUnlocks must be a boolean");
    if (loaded.gateSchedule !== "local" && loaded.gateSchedule !== "freeze") throw new TypeError("hmp-doors gateSchedule must be local or freeze");
    const adminGroups = loaded.adminGroups.map((entry, index) => ({
        key: cleanId(entry?.key, `admin group ${index} key`).toLowerCase(),
        minimumGrade: Number.isSafeInteger(Number(entry?.minimumGrade)) ? Number(entry.minimumGrade) : 0,
    }));
    return {
        command, enableCommands, adminGroups,
        shareUnlocks: loaded.shareUnlocks,
        gateSchedule: loaded.gateSchedule,
        heldGates: normalizeHeldGates(loaded.heldGates),
        rules: loaded.rules.map(normalizeRule),
    };
}

export = { loadConfig, normalizeRule };
