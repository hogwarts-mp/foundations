import policyModule = require("./policy");
import type { HmpDoorPlayer, HmpDoorResolution } from "../types";
import type { DoorDependencies, DoorService } from "./internal";

const { evaluateRules } = policyModule;
const METADATA_KEY = "hmp-doors:grants";

function cleanDoorName(value: unknown): string {
    const name = String(value || "").trim();
    if (!name || name.length > 200) throw new TypeError("doorName must be a non-empty string up to 200 characters");
    return name;
}

function createDoorService<P extends HmpDoorPlayer>(dependencies: DoorDependencies<P>): DoorService<P> {
    const { core, config } = dependencies;
    const now = dependencies.now || Date.now;
    const startedAt = now();
    const synced = new Set<number>();
    let stopped = false;

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
        return { player, character: activeCharacter(player), groups, grants, policy: evaluateRules(config.rules, groups, grants) };
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
        stop: () => { stopped = true; synced.clear(); },
    });
}

export = { createDoorService, cleanDoorName, METADATA_KEY };
