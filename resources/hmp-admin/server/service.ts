import { randomUUID } from "node:crypto";
import type { HmpAdminCapability, HmpAdminPlayerSummary, HmpAdminTravelDestination } from "../types";
import type {
    AdminConfig,
    AdminPermissions,
    AdminRepository,
    Banking,
    Characters,
    Core,
    Inventory,
    Jobs,
    Logger,
    Player,
    Spells,
    World,
} from "./internal";
import type { HmpCoreGroup, HmpCoreSession } from "../../hmp-core/types";
import type { HmpWorldSeason } from "../../hmp-world/types";

interface TeleportWaiter<T = number> {
    playerId: number;
    resolve: (result: T) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

const ADMIN_HOLD = "hmp-admin";
const TRAVEL_PLACES = ["intro.gringotts", "intro.vault", "intro.cliffside"] as const;
// The host answers every map travel within 180 s, timed out or not; this only covers an answer that never comes.
const MAP_TRAVEL_GUARD_MS = 190000;
const MAP_TRAVEL_FAILURES: Record<number, string> = {
    1: "a newer map travel replaced it",
    2: "the player's client could not travel",
    3: "the player's client does not have that map installed",
    4: "it timed out before the player was playable there",
    5: "the load settled in another map",
};

function adminError(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code });
}

function createAdminService(options: {
    repository: AdminRepository;
    permissions: AdminPermissions;
    core: Core;
    inventory: Inventory;
    banking: Banking;
    characters: Characters;
    jobs: Jobs;
    spells: Spells;
    world: World;
    config: AdminConfig;
    logger: Logger;
    migrations: Parameters<AdminRepository["start"]>[0];
    listPlayers: () => Player[];
    getPlayer: (id: number) => Player | null;
}) {
    const { repository, permissions, core, inventory, banking, characters, jobs, spells, world, config, logger, migrations, listPlayers, getPlayer } = options;
    const pendingTeleports = new Map<string, TeleportWaiter>();
    const pendingMapTravels = new Map<string, TeleportWaiter<HogwartsMpMapTravelCompletion>>();
    const activeNoclip = new Set<number>();
    let groupChanges: Promise<unknown> = Promise.resolve();
    const startedAt = Date.now();
    let state: "starting" | "ready" | "degraded" | "stopped" = "starting";
    let lastError = "";
    const startPromise = repository.start(migrations).then(() => { state = "ready"; }).catch((error: unknown) => {
        state = "degraded";
        lastError = error instanceof Error ? error.message : String(error);
        throw error;
    });

    function session(player: Player) {
        const value = core.sessions.get(player);
        if (!value) throw adminError("HMP_ADMIN_SESSION_MISSING", "That player's account session is not ready.");
        return value;
    }

    function targetPlayer(target: Player | number): Player {
        const player = typeof target === "number" ? getPlayer(Math.trunc(target)) : target;
        if (!player || !core.sessions.get(player)) throw adminError("HMP_ADMIN_PLAYER_NOT_FOUND", "That player is no longer connected.");
        return player;
    }

    function reasonOf(value: unknown, fallback: string): string {
        return (String(value || "").trim().slice(0, 500) || fallback);
    }

    function integer(value: unknown, label: string, minimum: number, maximum: number): number {
        const result = Number(value);
        if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
        return result;
    }

    function decimal(value: unknown, label: string, minimum: number, maximum: number): number {
        const result = Number(value);
        if (!Number.isFinite(result) || result < minimum || result > maximum) throw new TypeError(`${label} must be a number from ${minimum} to ${maximum}`);
        return result;
    }

    function calendarDate(rawDay: number, rawMonth: number, rawYear: number): { day: number; month: number; year: number } {
        const month = integer(rawMonth, "month", 1, 12);
        const year = integer(rawYear, "year", 0, 65535);
        const maximumDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
        const day = integer(rawDay, "day", 1, maximumDay);
        return { day, month, year };
    }

    function season(value: unknown): HmpWorldSeason {
        const names = ["spring", "summer", "autumn", "winter"] as const;
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 3) return value as 0 | 1 | 2 | 3;
        const name = String(value || "").trim().toLowerCase();
        if (names.includes(name as typeof names[number])) return name as typeof names[number];
        throw new TypeError("season must be spring, summer, autumn, or winter");
    }

    function locationOf(player: Player): HogwartsMpPlayerLocation | null {
        try { return typeof player.location === "function" ? player.location() : null; }
        catch (_) { return null; }
    }

    function isDead(player: Player): boolean {
        try { return typeof player.isDead === "function" && player.isDead() === true; }
        catch (_) { return false; }
    }

    function requireSameArea(left: Player, right: Player): void {
        const leftLocation = locationOf(left);
        const rightLocation = locationOf(right);
        if (!leftLocation || !rightLocation) throw adminError("HMP_ADMIN_LOCATION_UNAVAILABLE", "Both players must be in a playable game area.");
        if (leftLocation.areaId.toLowerCase() !== rightLocation.areaId.toLowerCase()) {
            throw adminError("HMP_ADMIN_AREA_MISMATCH", "Both players must be in the same game area.");
        }
    }

    async function summary(target: Player): Promise<HmpAdminPlayerSummary> {
        const current = session(target);
        let position = { x: 0, y: 0, z: 0 };
        try { position = { x: Number(target.position.x), y: Number(target.position.y), z: Number(target.position.z) }; } catch (_) {}
        return {
            playerId: target.id,
            nickname: String(target.nickname || `Player ${target.id}`),
            ping: Number(target.ping) || 0,
            account: current.account,
            character: current.character,
            principal: current.principal,
            groups: await core.groups.effective(target),
            position,
            location: locationOf(target),
            virtualWorld: Number(target.virtualWorld) || 0,
            frozen: Boolean(target.holds?.().some((hold) => hold.owner === ADMIN_HOLD)),
            dead: isDead(target),
        };
    }

    async function audited<T>(actor: Player, capability: HmpAdminCapability, action: string, target: Player | null, reason: string, metadata: Record<string, unknown>, work: () => Promise<T> | T): Promise<T> {
        await startPromise;
        await permissions.require(actor, capability);
        const actorSession = session(actor);
        const targetSession = target ? session(target) : null;
        const id = await repository.beginAudit({ actor: actorSession, action, target: targetSession, reason: reasonOf(reason, action), metadata });
        try {
            const result = await work();
            try { await repository.finishAudit(id, "completed"); }
            catch (error) { logger.error(`Could not complete admin audit #${id}: ${error instanceof Error ? error.message : String(error)}`); }
            return result;
        } catch (error) {
            try { await repository.finishAudit(id, "failed", error instanceof Error ? error.message : String(error)); }
            catch (auditError) { logger.error(`Could not fail admin audit #${id}: ${auditError instanceof Error ? auditError.message : String(auditError)}`); }
            throw error;
        }
    }

    function gradeIn(groups: HmpCoreGroup[], key: string): number | null {
        return groups.reduce<number | null>((grade, group) => group.key === key && (grade === null || group.grade > grade) ? group.grade : grade, null);
    }

    function isStaffGroup(key: string): boolean {
        return config.roleRules.some((rule) => String(rule.group).trim().toLowerCase() === key) || config.protectedGroups.includes(key);
    }

    // admin.groups alone would let staff raise themselves or an ally to any grade. In a staff group,
    // staff may only change someone ranked below them, only to a grade below their own, and never
    // their own account. A bootstrapped session stands in for the server owner and is exempt.
    async function requireGroupAuthority(actor: Player, target: HmpCoreSession<Player>, key: string, grade: number | null): Promise<void> {
        if (!isStaffGroup(key) || permissions.isBootstrapped(actor)) return;
        if (session(actor).account.id === target.account.id) throw adminError("HMP_ADMIN_SELF_TARGET", "You cannot change your own staff groups.");
        const own = gradeIn(await core.groups.effective(actor), key);
        if (own === null) throw adminError("HMP_ADMIN_GRADE_HIERARCHY", `You hold no '${key}' grade, so you cannot change anyone's.`);
        // The rows about to change, not the target's live session, which may have switched character since.
        const rows = [...await core.groups.listAccount(target.account.id), ...target.character ? await core.groups.listCharacter(target.character.id) : []];
        const current = gradeIn(rows, key);
        if (current !== null && current >= own) throw adminError("HMP_ADMIN_GRADE_HIERARCHY", `That player's '${key}' grade (${current}) is not below yours (${own}).`);
        if (grade !== null && grade >= own) throw adminError("HMP_ADMIN_GRADE_HIERARCHY", `You can only assign '${key}' grades below your own (${own}).`);
    }

    // One group change at a time, so each authority check sees every change queued ahead of it.
    function serially<T>(work: () => Promise<T>): Promise<T> {
        const result = groupChanges.then(work);
        groupChanges = result.catch(() => undefined);
        return result;
    }

    function waitForTeleport(player: Player, destination: { x: number; y: number; z: number }): Promise<number> {
        let requestId: number;
        try { requestId = Number(player.teleport(destination.x, destination.y, destination.z, { snapToGround: true, groundSnapDistance: 2000 })); }
        catch (error) { return Promise.reject(error); }
        if (!Number.isSafeInteger(requestId) || requestId < 1) return Promise.reject(adminError("HMP_ADMIN_TELEPORT_REJECTED", "The streamed teleport was not accepted."));
        const key = `${player.id}:${requestId}`;
        return new Promise<number>((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingTeleports.delete(key);
                reject(adminError("HMP_ADMIN_TELEPORT_TIMEOUT", "The administrative teleport timed out."));
            }, config.teleportTimeoutMs);
            pendingTeleports.set(key, { playerId: player.id, resolve, reject, timer });
        });
    }

    function onTeleportComplete(player: Player, requestId: number, status: number, completion?: HogwartsMpTeleportCompletion): boolean {
        const key = `${player.id}:${Number(requestId)}`;
        const pending = pendingTeleports.get(key);
        if (!pending) return false;
        clearTimeout(pending.timer);
        pendingTeleports.delete(key);
        if (Number(status) === 0 && completion?.destination) pending.resolve(Number(requestId));
        else pending.reject(adminError("HMP_ADMIN_TELEPORT_FAILED", "The administrative teleport did not reach its destination."));
        return true;
    }

    function waitForMapTravel(player: Player, start: () => number): Promise<HogwartsMpMapTravelCompletion> {
        let requestId: number;
        try { requestId = Number(start()); }
        catch (error) { return Promise.reject(error); }
        if (!Number.isSafeInteger(requestId) || requestId < 1) return Promise.reject(adminError("HMP_ADMIN_TRAVEL_REJECTED", "The map travel was not accepted."));
        const key = `${player.id}:${requestId}`;
        return new Promise<HogwartsMpMapTravelCompletion>((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingMapTravels.delete(key);
                reject(adminError("HMP_ADMIN_TRAVEL_TIMEOUT", "The map travel never reported back."));
            }, MAP_TRAVEL_GUARD_MS);
            pendingMapTravels.set(key, { playerId: player.id, resolve, reject, timer });
        });
    }

    function onMapTravelComplete(player: Player, requestId: number, status: number, completion?: HogwartsMpMapTravelCompletion): boolean {
        const key = `${player.id}:${Number(requestId)}`;
        const pending = pendingMapTravels.get(key);
        if (!pending) return false;
        clearTimeout(pending.timer);
        pendingMapTravels.delete(key);
        // 6 still arrived, only without one of the extra levels; the caller reads it from the completion.
        if ((Number(status) === 0 || Number(status) === 6) && completion) pending.resolve(completion);
        else pending.reject(adminError("HMP_ADMIN_TRAVEL_FAILED", `The map travel did not arrive: ${MAP_TRAVEL_FAILURES[Number(status)] || `status ${status}`}.`));
        return true;
    }

    const players = Object.freeze({
        async list(actor: Player) {
            await permissions.require(actor, "admin.view");
            return Promise.all(listPlayers().filter((player) => core.sessions.get(player)).map(summary));
        },
        async get(actor: Player, target: Player | number) {
            await permissions.require(actor, "admin.view");
            return summary(targetPlayer(target));
        },
    });

    const environment = Object.freeze({
        async state(actor: Player) {
            await permissions.require(actor, "admin.environment");
            return world.environment.state();
        },
        async baseline(actor: Player) {
            await permissions.require(actor, "admin.environment");
            return world.environment.baseline();
        },
        async weather(actor: Player, rawWeather: string, reason = "") {
            const weather = String(rawWeather || "").trim();
            if (!weather || weather.length > 128) throw new TypeError("weather must be a non-empty string up to 128 characters");
            const previous = world.environment.state()?.weather ?? null;
            return audited(actor, "admin.environment", "environment.weather", null, reason, { previous, weather }, () => {
                if (!world.environment.setWeather(weather)) throw adminError("HMP_ADMIN_ENVIRONMENT_REJECTED", `The Framework rejected weather '${weather}'.`);
                return true;
            });
        },
        async time(actor: Player, rawHour: number, rawMinute: number, rawSecond = 0, reason = "") {
            const hour = integer(rawHour, "hour", 0, 23);
            const minute = integer(rawMinute, "minute", 0, 59);
            const second = integer(rawSecond, "second", 0, 59);
            const previous = world.environment.state();
            return audited(actor, "admin.environment", "environment.time", null, reason, { previous: previous ? { hour: previous.hour, minute: previous.minute, second: previous.second } : null, hour, minute, second }, () => {
                if (!world.environment.setTime(hour, minute, second)) throw adminError("HMP_ADMIN_ENVIRONMENT_REJECTED", "The Framework rejected that world time.");
                return true;
            });
        },
        async date(actor: Player, rawDay: number, rawMonth: number, rawYear = 0, reason = "") {
            const { day, month, year } = calendarDate(rawDay, rawMonth, rawYear);
            const previous = world.environment.state();
            return audited(actor, "admin.environment", "environment.date", null, reason, { previous: previous ? { day: previous.day, month: previous.month, year: previous.year } : null, day, month, year }, () => {
                if (!world.environment.setDate(day, month, year)) throw adminError("HMP_ADMIN_ENVIRONMENT_REJECTED", "The Framework rejected that world date.");
                return true;
            });
        },
        async season(actor: Player, rawSeason: HmpWorldSeason, reason = "") {
            const value = season(rawSeason);
            const previous = world.environment.state()?.season ?? null;
            return audited(actor, "admin.environment", "environment.season", null, reason, { previous, season: value }, () => {
                if (!world.environment.setSeason(value)) throw adminError("HMP_ADMIN_ENVIRONMENT_REJECTED", "The Framework rejected that world season.");
                return true;
            });
        },
        async timeScale(actor: Player, rawScale: number, reason = "") {
            const scale = decimal(rawScale, "time scale", 0, 600);
            const previous = world.environment.state()?.timeScale ?? null;
            return audited(actor, "admin.environment", "environment.time-scale", null, reason, { previous, scale }, () => {
                if (!world.environment.setTimeScale(scale)) throw adminError("HMP_ADMIN_ENVIRONMENT_REJECTED", "The Framework rejected that clock speed.");
                return true;
            });
        },
        async reset(actor: Player, reason = "") {
            const previous = world.environment.state();
            const baseline = world.environment.baseline();
            return audited(actor, "admin.environment", "environment.reset", null, reason, { previous, baseline }, () => world.environment.reset());
        },
    });

    // Server-owned, so the admin's own client cannot undo it; a server without setVisible just leaves
    // the admin visible.
    function setNoclipHidden(player: Player | null | undefined, hidden: boolean): void {
        if (config.noclip.hide === false) return;
        try { (player as { setVisible?: (visible: boolean) => void } | null | undefined)?.setVisible?.(!hidden); }
        catch (error) { logger.warn(`Could not ${hidden ? "hide" : "reveal"} player #${player?.id}: ${error instanceof Error ? error.message : String(error)}`); }
    }

    // The hold already pins them for everyone else; this only stops their own client walking off it.
    function setInputFrozen(player: Player | null | undefined, frozen: boolean): void {
        try { player?.emit("hmp-admin:freeze", JSON.stringify({ frozen })); }
        catch (error) { logger.warn(`Could not ${frozen ? "freeze" : "restore"} input for player #${player?.id}: ${error instanceof Error ? error.message : String(error)}`); }
    }

    function onHoldEnded(player: Player, owner: string, reason: string): boolean {
        if (owner !== ADMIN_HOLD) return false;
        if (reason !== "disconnect") setInputFrozen(player, false);
        return true;
    }

    const noclip = Object.freeze({
        isActive(player: Player | number): boolean {
            const id = typeof player === "number" ? Math.trunc(player) : player?.id;
            return typeof id === "number" && activeNoclip.has(id);
        },
    });

    const actions = Object.freeze({
        environment,
        async noclip(actor: Player, reason = "Toggle administrator no-clip") {
            const enabled = !activeNoclip.has(actor.id);
            return audited(actor, "admin.noclip", `player.noclip.${enabled ? "enable" : "disable"}`, actor, reason, { enabled }, () => {
                actor.emit("hmp-admin:noclip", JSON.stringify({ enabled, ...config.noclip }));
                setNoclipHidden(actor, enabled);
                if (enabled) activeNoclip.add(actor.id); else activeNoclip.delete(actor.id);
                return enabled;
            });
        },
        async kick(actor: Player, target: Player | number, reason: string) {
            const player = targetPlayer(target);
            if (player === actor) throw adminError("HMP_ADMIN_SELF_TARGET", "You cannot kick yourself.");
            return audited(actor, "admin.kick", "player.kick", player, reason, {}, () => {
                if (typeof player.kick !== "function") throw adminError("HMP_ADMIN_ACTION_UNAVAILABLE", "Player kicking is unavailable.");
                player.kick(reasonOf(reason, "Removed by an administrator."));
                return true;
            });
        },
        async goto(actor: Player, target: Player | number, reason = "Go to player") {
            const player = targetPlayer(target);
            if (Number(actor.virtualWorld) !== Number(player.virtualWorld)) throw adminError("HMP_ADMIN_WORLD_MISMATCH", "Both players must be in the same virtual world.");
            requireSameArea(actor, player);
            return audited(actor, "admin.teleport", "player.goto", player, reason, {}, () => waitForTeleport(actor, { x: player.position.x + 100, y: player.position.y, z: player.position.z + 50 }));
        },
        async bring(actor: Player, target: Player | number, reason = "Bring player") {
            const player = targetPlayer(target);
            if (player === actor) throw adminError("HMP_ADMIN_SELF_TARGET", "You cannot bring yourself.");
            if (Number(actor.virtualWorld) !== Number(player.virtualWorld)) throw adminError("HMP_ADMIN_WORLD_MISMATCH", "Both players must be in the same virtual world.");
            requireSameArea(actor, player);
            return audited(actor, "admin.teleport", "player.bring", player, reason, {}, () => waitForTeleport(player, { x: actor.position.x + 100, y: actor.position.y, z: actor.position.z + 50 }));
        },
        async travel(actor: Player, target: Player | number, destination: HmpAdminTravelDestination, reason = "") {
            const player = targetPlayer(target);
            const place = "place" in destination ? String(destination.place || "").trim().toLowerCase() as typeof TRAVEL_PLACES[number] : null;
            const map = "map" in destination ? String(destination.map || "").trim() : "";
            const playerStart = "map" in destination ? String(destination.playerStart || "").trim() : "";
            if (place !== null && !TRAVEL_PLACES.includes(place)) throw new TypeError(`place must be one of ${TRAVEL_PLACES.join(", ")}`);
            if (place === null && !map) throw new TypeError("map must be a package path such as /Game/Levels/Overland/Overland");
            return audited(actor, "admin.teleport", "player.travel", player, reason, place ? { place } : { map, playerStart }, () => {
                const method = place ? "travelToPlace" : "travelToMap";
                if (typeof player[method] !== "function") throw adminError("HMP_ADMIN_ACTION_UNAVAILABLE", `Sending a player to a map needs a HogwartsMP host with player.${method}.`);
                return waitForMapTravel(player, () => place ? player.travelToPlace!(place) : player.travelToMap!(map, playerStart ? { playerStart } : undefined));
            });
        },
        async freeze(actor: Player, target: Player | number, reason = "Freeze player") {
            const player = targetPlayer(target);
            return audited(actor, "admin.freeze", "player.freeze", player, reason, {}, () => {
                if (typeof player.hold !== "function") throw adminError("HMP_ADMIN_ACTION_UNAVAILABLE", "Server-authoritative player holds are unavailable.");
                const held = player.hold({ owner: ADMIN_HOLD, x: player.position.x, y: player.position.y, z: player.position.z, radius: 25, radiusZ: 100, mode: "clamp" });
                if (held) setInputFrozen(player, true);
                return held;
            });
        },
        async release(actor: Player, target: Player | number, reason = "Release player") {
            const player = targetPlayer(target);
            return audited(actor, "admin.freeze", "player.release", player, reason, {}, () => {
                if (typeof player.release !== "function") throw adminError("HMP_ADMIN_ACTION_UNAVAILABLE", "Server-authoritative player holds are unavailable.");
                const released = player.release(ADMIN_HOLD);
                setInputFrozen(player, false);
                return released;
            });
        },
        async revive(actor: Player, target: Player | number, reason = "Revive player") {
            const player = targetPlayer(target);
            if (!isDead(player)) throw adminError("HMP_ADMIN_NOT_DEAD", "That player is not dead.");
            return audited(actor, "admin.freeze", "player.revive", player, reason, {}, () => {
                if (typeof player.revive !== "function") throw adminError("HMP_ADMIN_ACTION_UNAVAILABLE", "Reviving a player needs a HogwartsMP host with player.revive.");
                // The host orders an automatic respawn as the player dies, and a revive cannot overtake it.
                if (!player.revive()) throw adminError("HMP_ADMIN_REVIVE_REJECTED", "A respawn or revive is already on its way for that player.");
                return true;
            });
        },
        async inventory(actor: Player, target: Player | number, operation: "give" | "remove", item: string, amount: number, reason = "") {
            const player = targetPlayer(target);
            const quantity = Math.trunc(Number(amount));
            if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new TypeError("amount must be a positive integer");
            return audited(actor, "admin.inventory", `inventory.${operation}`, player, reason, { item, amount: quantity }, () => operation === "give"
                ? inventory.inventory.add(player, item, quantity, { identified: true })
                : inventory.inventory.remove(player, item, quantity));
        },
        async transmogCurrent(actor: Player, target: Player | number) {
            await permissions.require(actor, "admin.appearance");
            const player = targetPlayer(target);
            if (!session(player).character) throw adminError("HMP_ADMIN_CHARACTER_MISSING", "The target has no active character.");
            return characters.appearance.getTransmog(player);
        },
        async transmogs(actor: Player) {
            await permissions.require(actor, "admin.appearance");
            return characters.appearance.listTransmogs();
        },
        async transmog(actor: Player, target: Player | number, operation: "set" | "unset", rawTransmog: string, reason = "") {
            await permissions.require(actor, "admin.appearance");
            const player = targetPlayer(target);
            if (!session(player).character) throw adminError("HMP_ADMIN_CHARACTER_MISSING", "The target has no active character.");
            if (operation !== "set" && operation !== "unset") throw new TypeError("operation must be set or unset");
            const transmog = String(rawTransmog || "").trim();
            if (operation === "set" && !transmog) throw new TypeError("transmog character id is required");
            const previous = await characters.appearance.getTransmog(player);
            return audited(actor, "admin.appearance", `appearance.transmog.${operation}`, player, reason, { previous, transmog: operation === "set" ? transmog : "" }, () => operation === "set"
                ? characters.appearance.setTransmog(player, transmog)
                : characters.appearance.clearTransmog(player));
        },
        async spellGrants(actor: Player, target: Player | number) {
            await permissions.require(actor, "admin.spells");
            const player = targetPlayer(target);
            if (!session(player).character) throw adminError("HMP_ADMIN_CHARACTER_MISSING", "The target has no active character.");
            return spells.grants.list(player);
        },
        async spell(actor: Player, target: Player | number, operation: "grant" | "revoke", rawSpell: string, reason: string) {
            const player = targetPlayer(target);
            if (!session(player).character) throw adminError("HMP_ADMIN_CHARACTER_MISSING", "The target has no active character.");
            if (operation !== "grant" && operation !== "revoke") throw new TypeError("operation must be grant or revoke");
            const definition = spells.catalog.get(String(rawSpell || ""));
            if (!definition) throw new TypeError(`Unknown spell '${String(rawSpell || "")}'`);
            const note = reasonOf(reason, `${operation === "grant" ? "Granted" : "Revoked"} by an administrator`);
            return audited(actor, "admin.spells", `spells.${operation}`, player, note, { spell: definition.lockId, name: definition.name }, () => spells.grants[operation](player, definition.lockId, { resource: "hmp-admin", actor, reason: note }));
        },
        async group(actor: Player, target: Player | number, operation: "set" | "remove", scope: "account" | "character", group: string, grade: number, reason: string) {
            const player = targetPlayer(target);
            const targetSession = session(player);
            const key = String(group || "").trim().toLowerCase();
            if (!key) throw new TypeError("group is required");
            const value = Math.max(0, Math.trunc(Number(grade)) || 0);
            return audited(actor, "admin.groups", `group.${operation}`, player, reason, { scope, group: key, grade: value }, () => serially(async () => {
                // Again in turn: a demotion queued ahead of this change may have taken admin.groups away.
                await permissions.require(actor, "admin.groups");
                if (scope !== "account" && !targetSession.character) throw adminError("HMP_ADMIN_CHARACTER_MISSING", "The target has no active character.");
                await requireGroupAuthority(actor, targetSession, key, operation === "set" ? value : null);
                if (scope === "account") {
                    if (operation === "set") await core.groups.setAccount(targetSession.account.id, key, value, { source: "hmp-admin" });
                    else await core.groups.removeAccount(targetSession.account.id, key);
                } else {
                    if (operation === "set") await core.groups.setCharacter(targetSession.character!.id, key, value, { source: "hmp-admin" });
                    else await core.groups.removeCharacter(targetSession.character!.id, key);
                }
                return true;
            }));
        },
        async job(actor: Player, target: Player | number, operation: "hire" | "fire" | "grade", job: string, grade: number, reason: string) {
            const player = targetPlayer(target);
            const targetSession = session(player);
            if (!targetSession.character) throw adminError("HMP_ADMIN_CHARACTER_MISSING", "The target has no active character.");
            const jobId = String(job || "").trim().toLowerCase();
            return audited(actor, "admin.jobs", `job.${operation}`, player, reason, { job: jobId, grade }, async () => {
                const opts = { resource: "hmp-admin", actor, reason };
                if (operation === "hire") await jobs.employment.hire(targetSession.character!.id, jobId, Math.trunc(Number(grade)) || 0, opts);
                else if (operation === "fire") await jobs.employment.fire(targetSession.character!.id, jobId, opts);
                else await jobs.employment.setGrade(targetSession.character!.id, jobId, Math.trunc(Number(grade)) || 0, opts);
                return true;
            });
        },
        async banking(actor: Player, target: Player | number, operation: "credit" | "debit", amount: number, currency: string, reason: string) {
            const player = targetPlayer(target);
            const targetSession = session(player);
            if (!targetSession.character) throw adminError("HMP_ADMIN_CHARACTER_MISSING", "The target has no active character.");
            const quantity = Math.trunc(Number(amount));
            if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new TypeError("amount must be a positive integer");
            return audited(actor, "admin.banking", `banking.${operation}`, player, reason, { amount: quantity, currency }, async () => {
                const account = await banking.accounts.personal(targetSession.character!.id, String(currency || "galleons").toLowerCase());
                await banking.transactions[operation](account, quantity, { resource: "hmp-admin", reference: `admin:${randomUUID()}`, memo: reasonOf(reason, `Admin ${operation}`), actor });
                return true;
            });
        },
        async reconcile(actor: Player, reference: string, resolution: "complete" | "compensate" | "fail", reason: string) {
            const key = String(reference || "").trim();
            return audited(actor, "admin.reconcile", "banking.reconcile", null, reason, { reference: key, resolution }, async () => {
                await banking.transactions.reconcile(key, resolution, reasonOf(reason, "Administrative reconciliation"));
                return true;
            });
        },
    });

    const moderation = Object.freeze({
        async warn(actor: Player, target: Player | number, reason: string) {
            const player = targetPlayer(target);
            return audited(actor, "admin.warn", "moderation.warn", player, reason, {}, async () => {
                const warning = await repository.addWarning(session(player).account.id, session(actor).account.id, reasonOf(reason, "Staff warning"));
                player.emit("hmp-admin:warning", JSON.stringify({ id: warning.id, reason: warning.reason }));
                return warning;
            });
        },
        async warnings(actor: Player, target: Player | number) {
            await permissions.require(actor, "admin.view");
            return repository.warnings(session(targetPlayer(target)).account.id, config.auditPageSize);
        },
        async ban(actor: Player, target: Player | number, reason: string, hours = 0) {
            const player = targetPlayer(target);
            if (player === actor) throw adminError("HMP_ADMIN_SELF_TARGET", "You cannot ban yourself.");
            const targetSession = session(player);
            if (targetSession.principal.trust !== "verified" && !config.allowUnsafeAssertedBans) {
                throw adminError("HMP_ADMIN_UNVERIFIED_BAN", "Permanent moderation requires a verified target identity.");
            }
            const duration = Math.max(0, Math.min(87600, Number(hours) || 0));
            return audited(actor, "admin.ban", "moderation.ban", player, reason, { hours: duration }, async () => {
                const ban = await repository.addBan({
                    accountId: targetSession.account.id, provider: targetSession.principal.provider, subject: targetSession.principal.subject,
                    trust: targetSession.principal.trust, actorAccountId: session(actor).account.id, reason: reasonOf(reason, "Banned by an administrator"),
                    expiresAt: duration > 0 ? new Date(Date.now() + duration * 3600000) : null,
                });
                player.kick?.(`Banned: ${ban.reason}`);
                return ban;
            });
        },
        async unban(actor: Player, banId: number, reason: string) {
            return audited(actor, "admin.ban", "moderation.unban", null, reason, { banId }, () => repository.revokeBan(Math.trunc(Number(banId)), session(actor).account.id, reasonOf(reason, "Ban revoked")));
        },
        async bans(actor: Player, limit = config.auditPageSize) {
            await permissions.require(actor, "admin.ban");
            return repository.bans(Math.max(1, Math.min(200, Math.trunc(Number(limit)) || config.auditPageSize)));
        },
    });

    const audit = Object.freeze({
        async history(actor: Player, limit = config.auditPageSize, targetAccountId?: number) {
            await permissions.require(actor, "admin.audit");
            return repository.audit(Math.max(1, Math.min(200, Math.trunc(Number(limit)) || config.auditPageSize)), targetAccountId);
        },
    });

    async function onSessionReady(current: ReturnType<typeof session>): Promise<boolean> {
        await startPromise;
        const ban = await repository.activeBan(current);
        if (!ban) return false;
        current.player.kick?.(`Banned: ${ban.reason}`);
        return true;
    }

    async function revalidateNoclip(): Promise<number> {
        let revoked = 0;
        for (const playerId of [...activeNoclip]) {
            const player = getPlayer(playerId);
            if (player && await permissions.has(player, "admin.noclip")) continue;
            activeNoclip.delete(playerId);
            setNoclipHidden(player, false);
            try { player?.emit("hmp-admin:noclip", JSON.stringify({ enabled: false })); }
            catch (error) { logger.warn(`Could not notify player #${playerId} that no-clip was revoked: ${error instanceof Error ? error.message : String(error)}`); }
            revoked++;
        }
        return revoked;
    }

    function disconnect(player: Player): void {
        if (activeNoclip.delete(player.id)) {
            try { player.emit("hmp-admin:noclip", JSON.stringify({ enabled: false })); }
            catch (_) { /* the connection may already be gone */ }
        }
        permissions.revoke(player);
        for (const waiters of [pendingTeleports, pendingMapTravels]) for (const [key, pending] of waiters) {
            if (pending.playerId !== player.id) continue;
            clearTimeout(pending.timer);
            waiters.delete(key);
            pending.reject(adminError("HMP_ADMIN_PLAYER_DISCONNECTED", "The player disconnected during teleport."));
        }
    }

    async function stop(): Promise<void> {
        state = "stopped";
        for (const playerId of activeNoclip) {
            setNoclipHidden(getPlayer(playerId), false);
            try { getPlayer(playerId)?.emit("hmp-admin:noclip", JSON.stringify({ enabled: false })); }
            catch (_) { /* client cleanup also restores collision during resource stop */ }
        }
        activeNoclip.clear();
        // Clients restore their own input on resourceStop, so a hold left behind would pin them silently.
        for (const player of listPlayers()) {
            if (!player.holds?.().some((hold) => hold.owner === ADMIN_HOLD)) continue;
            try { player.release?.(ADMIN_HOLD); }
            catch (error) { logger.warn(`Could not release player #${player.id} on shutdown: ${error instanceof Error ? error.message : String(error)}`); }
        }
        for (const waiters of [pendingTeleports, pendingMapTravels]) for (const [key, pending] of waiters) {
            clearTimeout(pending.timer);
            waiters.delete(key);
            pending.reject(adminError("HMP_ADMIN_STOPPED", "hmp-admin stopped during teleport."));
        }
    }

    return Object.freeze({
        permissions,
        players,
        actions,
        moderation,
        audit,
        noclip,
        ready: () => startPromise,
        onSessionReady,
        onTeleportComplete,
        onMapTravelComplete,
        onHoldEnded,
        revalidateNoclip,
        disconnect,
        stop,
        status: () => ({ state, lastError, ...permissions.status(), pendingTeleports: pendingTeleports.size, activeNoclip: activeNoclip.size, uptimeMs: Date.now() - startedAt }),
    });
}

export = { createAdminService };
