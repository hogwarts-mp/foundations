import { randomUUID } from "node:crypto";
import type { HmpAdminCapability, HmpAdminPlayerSummary } from "../types";
import type {
    AdminConfig,
    AdminPermissions,
    AdminRepository,
    Banking,
    Core,
    Inventory,
    Jobs,
    Logger,
    Player,
    Spells,
} from "./internal";

interface TeleportWaiter {
    playerId: number;
    resolve: (requestId: number) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

function adminError(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code });
}

function createAdminService(options: {
    repository: AdminRepository;
    permissions: AdminPermissions;
    core: Core;
    inventory: Inventory;
    banking: Banking;
    jobs: Jobs;
    spells: Spells;
    config: AdminConfig;
    logger: Logger;
    migrations: Parameters<AdminRepository["start"]>[0];
    listPlayers: () => Player[];
    getPlayer: (id: number) => Player | null;
}) {
    const { repository, permissions, core, inventory, banking, jobs, spells, config, logger, migrations, listPlayers, getPlayer } = options;
    const pendingTeleports = new Map<string, TeleportWaiter>();
    const activeNoclip = new Set<number>();
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

    function locationOf(player: Player): HogwartsMpPlayerLocation | null {
        try { return typeof player.location === "function" ? player.location() : null; }
        catch (_) { return null; }
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
            frozen: Boolean(target.holds?.().some((hold) => hold.owner === "hmp-admin")),
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
            timer.unref?.();
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

    const actions = Object.freeze({
        async noclip(actor: Player, reason = "Toggle administrator no-clip") {
            const enabled = !activeNoclip.has(actor.id);
            return audited(actor, "admin.noclip", `player.noclip.${enabled ? "enable" : "disable"}`, actor, reason, { enabled }, () => {
                actor.emit("hmp-admin:noclip", JSON.stringify({ enabled, ...config.noclip }));
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
        async freeze(actor: Player, target: Player | number, reason = "Freeze player") {
            const player = targetPlayer(target);
            return audited(actor, "admin.freeze", "player.freeze", player, reason, {}, () => {
                if (typeof player.hold !== "function") throw adminError("HMP_ADMIN_ACTION_UNAVAILABLE", "Server-authoritative player holds are unavailable.");
                return player.hold({ owner: "hmp-admin", x: player.position.x, y: player.position.y, z: player.position.z, radius: 25, radiusZ: 100, mode: "clamp", rigid: true });
            });
        },
        async release(actor: Player, target: Player | number, reason = "Release player") {
            const player = targetPlayer(target);
            return audited(actor, "admin.freeze", "player.release", player, reason, {}, () => {
                if (typeof player.release !== "function") throw adminError("HMP_ADMIN_ACTION_UNAVAILABLE", "Server-authoritative player holds are unavailable.");
                return player.release("hmp-admin");
            });
        },
        async inventory(actor: Player, target: Player | number, operation: "give" | "remove", item: string, amount: number, reason = "") {
            const player = targetPlayer(target);
            const quantity = Math.trunc(Number(amount));
            if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new TypeError("amount must be a positive integer");
            return audited(actor, "admin.inventory", `inventory.${operation}`, player, reason, { item, amount: quantity }, () => inventory.inventory[operation === "give" ? "add" : "remove"](player, item, quantity));
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
            return audited(actor, "admin.groups", `group.${operation}`, player, reason, { scope, group: key, grade }, async () => {
                if (scope === "account") {
                    if (operation === "set") await core.groups.setAccount(targetSession.account.id, key, Math.max(0, Math.trunc(Number(grade)) || 0), { source: "hmp-admin" });
                    else await core.groups.removeAccount(targetSession.account.id, key);
                } else {
                    if (!targetSession.character) throw adminError("HMP_ADMIN_CHARACTER_MISSING", "The target has no active character.");
                    if (operation === "set") await core.groups.setCharacter(targetSession.character.id, key, Math.max(0, Math.trunc(Number(grade)) || 0), { source: "hmp-admin" });
                    else await core.groups.removeCharacter(targetSession.character.id, key);
                }
                return true;
            });
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
        for (const [key, pending] of pendingTeleports) {
            if (pending.playerId !== player.id) continue;
            clearTimeout(pending.timer);
            pendingTeleports.delete(key);
            pending.reject(adminError("HMP_ADMIN_PLAYER_DISCONNECTED", "The player disconnected during teleport."));
        }
    }

    async function stop(): Promise<void> {
        state = "stopped";
        for (const playerId of activeNoclip) {
            try { getPlayer(playerId)?.emit("hmp-admin:noclip", JSON.stringify({ enabled: false })); }
            catch (_) { /* client cleanup also restores collision during resource stop */ }
        }
        activeNoclip.clear();
        for (const [key, pending] of pendingTeleports) {
            clearTimeout(pending.timer);
            pendingTeleports.delete(key);
            pending.reject(adminError("HMP_ADMIN_STOPPED", "hmp-admin stopped during teleport."));
        }
    }

    return Object.freeze({
        permissions,
        players,
        actions,
        moderation,
        audit,
        ready: () => startPromise,
        onSessionReady,
        onTeleportComplete,
        revalidateNoclip,
        disconnect,
        stop,
        status: () => ({ state, lastError, ...permissions.status(), pendingTeleports: pendingTeleports.size, activeNoclip: activeNoclip.size, uptimeMs: Date.now() - startedAt }),
    });
}

export = { createAdminService };
