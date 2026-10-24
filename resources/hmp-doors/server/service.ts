import policyModule = require("./policy");
import type { HmpDoorHeldGate, HmpDoorPlayer, HmpDoorResolution } from "../types";
import type { DoorDependencies, DoorService } from "./internal";

const { evaluateRules, lockLevels } = policyModule;
const METADATA_KEY = "hmp-doors:grants";
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

function cleanDoorName(value: unknown): string {
    const name = String(value || "").trim();
    if (!name || name.length > 200) throw new TypeError("doorName must be a non-empty string up to 200 characters");
    return name;
}

function createDoorService<P extends HmpDoorPlayer>(dependencies: DoorDependencies<P>): DoorService<P> {
    const { core, config, logger } = dependencies;
    const now = dependencies.now || Date.now;
    const startedAt = now();
    const synced = new Set<number>();
    let stopped = false;
    let heldLevels = holdLockLevels();
    const hostShareUnlocks = applyShareUnlocks();
    let heldGates = holdGates();

    // A shared unlock is held for everyone and beats every player's policy. The setting is host-wide, so the
    // one found here is put back when the resource stops.
    function applyShareUnlocks(): boolean | undefined {
        const native = dependencies.doors;
        if (typeof native?.setShareUnlocks !== "function") {
            if (config.shareUnlocks) logger?.warn("shareUnlocks needs a HogwartsMP host with Doors.setShareUnlocks; every unlock stays in the opener's game");
            return undefined;
        }
        const previous = native.getShareUnlocks?.();
        native.setShareUnlocks(config.shareUnlocks);
        return previous;
    }

    // A host older than lockLevel ignores the axis and holds nothing, so the first level not read back marks it.
    function holdLockLevels(): string[] {
        const levels = lockLevels(config.rules);
        if (!levels.size) return [];
        const native = dependencies.doors;
        const held: string[] = [];
        for (const [selector, level] of levels) {
            try {
                native?.set(selector, { lockLevel: level });
                if (native?.get(selector)?.lockLevel !== level) {
                    logger?.warn("lockLevel rules need a HogwartsMP host with Doors lockLevel; every padlock keeps the level it shipped with");
                    break;
                }
                held.push(selector);
            }
            catch (error) { logger?.warn(`Could not hold lock level ${level} on '${selector}': ${messageOf(error)}`); }
        }
        return held;
    }

    function releaseLockLevels(): void {
        for (const selector of heldLevels) {
            try { dependencies.doors?.set(selector, { lockLevel: null }); }
            catch (error) { logger?.warn(`Could not release the lock level on '${selector}': ${messageOf(error)}`); }
        }
        heldLevels = [];
    }

    // A stop releases only the axes the config held, so another resource's hold on the same gate stays.
    function holdGates(): Array<[string, HmpDoorHeldGate]> {
        const entries = Object.entries(config.heldGates);
        const native = dependencies.gates;
        if (entries.length && !native) logger?.warn("heldGates needs a HogwartsMP host with the server Gates builtin; no gate is held");
        if (!native) return [];
        return entries.filter(([selector, state]) => {
            try { native.set(selector, state); return true; }
            catch (error) { logger?.warn(`Could not hold gate '${selector}': ${messageOf(error)}`); return false; }
        });
    }

    function releaseGates(): void {
        for (const [selector, state] of heldGates) {
            try { dependencies.gates?.set(selector, Object.fromEntries(Object.keys(state).map((axis) => [axis, null]))); }
            catch (error) { logger?.warn(`Could not release gate '${selector}': ${messageOf(error)}`); }
        }
        heldGates = [];
    }

    function activeCharacter(player: P) {
        return core.characters.active(player);
    }

    async function list(player: P): Promise<string[]> {
        const character = activeCharacter(player);
        if (!character) return [];
        const stored = await core.metadata.getCharacter<unknown>(character.id, METADATA_KEY);
        if (!Array.isArray(stored)) return [];
        return [...new Set(stored.map(String).map((name) => name.trim()).filter((name) => name && name.length <= 200))].sort();
    }

    async function write(player: P, values: string[]): Promise<void> {
        const character = activeCharacter(player);
        if (!character) throw new Error("No character is active");
        await core.metadata.setCharacter(character.id, METADATA_KEY, [...new Set(values)].sort());
    }

    async function resolve(player: P): Promise<HmpDoorResolution<P>> {
        if (stopped) throw new Error("hmp-doors is stopped");
        const [groups, grants] = await Promise.all([core.groups.effective(player), list(player)]);
        return { player, character: activeCharacter(player), groups, grants, policy: evaluateRules(config.rules, groups, grants, config.gateSchedule === "freeze") };
    }

    // hmp-core creates the session only after an awaited database round-trip, so playerConnect always
    // arrives first. hmp:session:ready re-syncs moments later, so treat a session-less player as
    // not-yet rather than as the failure it would otherwise be logged as.
    async function sync(player: P) {
        if (!core.sessions.isReady(player)) return null;
        const resolution = await resolve(player);
        player.emit("hmp-doors:policy", JSON.stringify(resolution.policy));
        synced.add(Number(player.id));
        return resolution.policy;
    }

    async function syncAll(): Promise<number> {
        const results = await Promise.all(dependencies.players().map(sync));
        return results.filter(Boolean).length;
    }

    async function grant(player: P, rawName: string): Promise<boolean> {
        const name = cleanDoorName(rawName);
        const values = await list(player);
        if (values.includes(name)) return false;
        values.push(name);
        await write(player, values);
        await sync(player);
        return true;
    }

    async function revoke(player: P, rawName: string): Promise<boolean> {
        const name = cleanDoorName(rawName);
        const values = await list(player);
        if (!values.includes(name)) return false;
        await write(player, values.filter((entry) => entry !== name));
        await sync(player);
        return true;
    }

    async function clear(player: P): Promise<number> {
        const values = await list(player);
        if (!values.length) return 0;
        await write(player, []);
        await sync(player);
        return values.length;
    }

    return Object.freeze({
        policy: Object.freeze({ resolve, sync, syncAll }),
        grants: Object.freeze({ list, grant, revoke, clear }),
        status: () => ({ state: stopped ? "stopped" as const : "ready" as const, rules: config.rules.length, syncedPlayers: synced.size, uptimeMs: now() - startedAt }),
        stop: () => {
            if (!stopped && typeof hostShareUnlocks === "boolean") dependencies.doors?.setShareUnlocks?.(hostShareUnlocks);
            stopped = true;
            synced.clear();
            releaseLockLevels();
            releaseGates();
        },
    });
}

export = { createDoorService, cleanDoorName, METADATA_KEY };
