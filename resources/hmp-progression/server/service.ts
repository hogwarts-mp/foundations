import normalizeModule = require("../shared/normalize");
import type {
    HmpProgressionMutationOptions,
    HmpProgressionRewardTransaction,
    HmpTalentMutationOptions,
} from "../types";
import type { Player, ProgressionDependencies, ProgressionService, RewardDraft, TalentMutation } from "./internal";

const { clean, positiveId, nonNegative, signed, limit, reference, talentId, metadata } = normalizeModule;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

interface NativePending {
    playerId: number;
    operation: string;
    resolve(value: Record<string, unknown>): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
}

function payloadObject(payload: unknown): Record<string, unknown> | null {
    if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch { return null; }
    }
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
}

function createProgressionService(dependencies: ProgressionDependencies): ProgressionService {
    const { repository, core, events, logger, config, migrations } = dependencies;
    const now = dependencies.now || Date.now;
    const setTimer = dependencies.setTimer || setTimeout;
    const clearTimer = dependencies.clearTimer || clearTimeout;
    const startedAt = now();
    const syncedPlayers = new Set<number>();
    const pendingNative = new Map<string, NativePending>();
    let requestSequence = 0;
    let state: "starting" | "ready" | "degraded" | "stopped" = "starting";
    let lastError = "";
    let pendingTransactions = 0;
    let startPromise: Promise<void> | null = null;

    function start(): Promise<void> {
        if (state === "stopped") return Promise.reject(new Error("hmp-progression is stopped"));
        if (startPromise) return startPromise;
        state = "starting";
        startPromise = repository.migrate(migrations).then(async () => {
            pendingTransactions = (await repository.pendingRewards(200)).length;
            state = "ready";
            lastError = "";
        }).catch((error) => {
            state = "degraded";
            lastError = messageOf(error).slice(0, 191);
            throw error;
        });
        return startPromise;
    }

    function playerId(player: Player): number {
        const id = Number(player?.id);
        if (!Number.isSafeInteger(id) || id < 0 || typeof player.emit !== "function") throw new TypeError("a connected player is required");
        return id;
    }
    function activeCharacter(player: Player) {
        playerId(player);
        const character = core.characters.active(player);
        if (!character) throw new Error("Select a character before using progression");
        return character;
    }
    function characterId(target: Player | number): number {
        return typeof target === "number" ? positiveId(target, "character id") : activeCharacter(target).id;
    }
    function actorCharacterId(actor: Player | number | null | undefined): number | null {
        return actor === undefined || actor === null ? null : characterId(actor);
    }
    function onlinePlayer(id: number): Player | null {
        return core.sessions.all().find((session) => session.character?.id === id)?.player || null;
    }
    // Resolved again after the sync: a player who left during it can't be copied into listeners' payloads.
    async function syncOnline(id: number): Promise<Player | null> {
        const player = onlinePlayer(id);
        if (!player) return null;
        await sync(player);
        return onlinePlayer(id);
    }
    // Events.emit rejects when any listener throws. Unhandled, that rejection is charged to this resource
    // as a runtime error, and the server stops sending progression to joining clients.
    function emit(eventName: string, payload: Record<string, unknown>): void {
        void Promise.resolve(events.emit(eventName, payload)).catch((error: unknown) => {
            const errors = error && typeof error === "object" && Array.isArray((error as { errors?: unknown }).errors) ? (error as { errors: unknown[] }).errors : [error];
            logger.warn(`A ${eventName} listener failed: ${errors.map(messageOf).join("; ")}`);
        });
    }
    function resource(value: unknown): string { return clean(value, "source resource", 64); }
    function reason(value: unknown): string { return String(value || "").trim().slice(0, 191); }

    async function sync(player: Player) {
        await start();
        const character = activeCharacter(player);
        const profile = await repository.profile(character.id);
        const talents = await repository.talents(character.id, true);
        player.emit!("hmp-progression:sync", JSON.stringify({
            characterId: character.id,
            revision: profile.revision,
            experiencePoints: profile.experiencePoints,
            talentPoints: profile.talentPoints,
            preserveTalentPoints: profile.appliedRevision >= profile.revision,
            talents: talents.map((entry) => ({ id: entry.talentId, level: entry.level, status: entry.status })),
        }));
        syncedPlayers.add(playerId(player));
        return profile;
    }

    function draft(target: Player | number, operation: "add" | "set", rawAmount: number, options: HmpProgressionMutationOptions<Player>): RewardDraft {
        if (!options) throw new TypeError("progression mutation options are required");
        const amount = operation === "add" ? signed(rawAmount, "experience adjustment", config.maximumExperience) : nonNegative(rawAmount, "experience target", config.maximumExperience);
        return {
            reference: reference(options.reference), characterId: characterId(target), operation, amount,
            actorCharacterId: actorCharacterId(options.actor), resource: resource(options.resource),
            reason: reason(options.reason), metadata: metadata(options.metadata),
        };
    }

    function assertReplay(transaction: HmpProgressionRewardTransaction, expected: RewardDraft): void {
        if (transaction.characterId !== expected.characterId || transaction.operation !== expected.operation || transaction.amount !== expected.amount || transaction.actorCharacterId !== expected.actorCharacterId || transaction.resource !== expected.resource) {
            throw Object.assign(new Error(`Progression reference '${expected.reference}' was reused for a different operation`), { code: "HMP_PROGRESSION_REFERENCE" });
        }
    }

    async function mutate(target: Player | number, operation: "add" | "set", amount: number, options: HmpProgressionMutationOptions<Player>): Promise<HmpProgressionRewardTransaction> {
        await start();
        const expected = draft(target, operation, amount, options);
        const begun = await repository.beginReward(expected);
        assertReplay(begun.transaction, expected);
        if (begun.transaction.status === "failed") throw new Error(`Progression reward '${expected.reference}' failed: ${begun.transaction.error}`);
        const shouldEmit = begun.transaction.status !== "completed";
        let transaction: HmpProgressionRewardTransaction;
        try { transaction = shouldEmit ? await repository.applyReward(expected.reference, config.maximumExperience) : begun.transaction; }
        catch (error) {
            if (begun.transaction.status === "pending") await repository.failReward(expected.reference, messageOf(error));
            pendingTransactions = (await repository.pendingRewards(200)).length;
            throw error;
        }
        pendingTransactions = (await repository.pendingRewards(200)).length;
        const synced = onlinePlayer(expected.characterId);
        const profile = synced ? await sync(synced) : await repository.profile(expected.characterId);
        const player = synced && onlinePlayer(expected.characterId);
        if (shouldEmit) emit("hmp:progression:changed", { player, character: player ? core.characters.active(player) : null, profile, transaction });
        return transaction;
    }

    function requestNative(player: Player, operation: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
        const id = `${playerId(player).toString(36)}:${now().toString(36)}:${(++requestSequence).toString(36)}`;
        return new Promise((resolve, reject) => {
            const timer = setTimer(() => {
                pendingNative.delete(id);
                reject(new Error(`Native ${operation} request timed out`));
            }, config.nativeRequestTimeoutMs);
            pendingNative.set(id, { playerId: playerId(player), operation, resolve, reject, timer });
            player.emit!("hmp-progression:request", JSON.stringify({ requestId: id, operation, ...data }));
        });
    }

    async function nativeResult(player: Player, rawPayload: unknown): Promise<void> {
        const payload = payloadObject(rawPayload);
        if (!payload) return;
        const requestId = String(payload.requestId || "");
        const pending = pendingNative.get(requestId);
        if (!pending || pending.playerId !== playerId(player) || pending.operation !== String(payload.operation || "")) return;
        pendingNative.delete(requestId);
        clearTimer(pending.timer);
        pending.resolve(payload);
    }

    async function nativeReport(player: Player, rawPayload: unknown): Promise<void> {
        const payload = payloadObject(rawPayload);
        if (!payload) return;
        const character = activeCharacter(player);
        const id = playerId(player);
        if (Number(payload.characterId) !== character.id) return;
        const revision = nonNegative(payload.revision, "native revision");
        const points = nonNegative(payload.experiencePoints, "native experience", config.maximumExperience);
        const level = nonNegative(payload.level, "native level", 40);
        const talentPoints = nonNegative(payload.talentPoints, "native talent points", config.maximumTalentPoints);
        if (level < 1) return;
        const current = await repository.profile(character.id);
        if (revision !== current.revision || points !== current.experiencePoints) return;
        const profile = await repository.acknowledge(character.id, revision, level, talentPoints);
        // Nothing to report if the player disconnected while the database answered.
        const online = onlinePlayer(character.id);
        if (!online || Number(online.id) !== id) return;
        emit("hmp:progression:synchronized", { player: online, character, profile });
    }

    function talentMutation(target: Player | number, rawTalentId: string, rawLevel: number | undefined, status: "owned" | "revoked", acquisition: "grant" | "purchase", options: HmpTalentMutationOptions<Player>): TalentMutation {
        if (!options) throw new TypeError("talent mutation options are required");
        const level = rawLevel === undefined ? 1 : nonNegative(rawLevel, "talent level", 255);
        if (level < 1) throw new TypeError("talent level must be at least 1");
        return {
            characterId: characterId(target), talentId: talentId(rawTalentId), level, status, acquisition,
            actorCharacterId: actorCharacterId(options.actor), resource: resource(options.resource), reason: reason(options.reason),
        };
    }

    async function setLevel(target: Player, rawLevel: number, options: HmpProgressionMutationOptions<Player>) {
        const level = nonNegative(rawLevel, "level", 40);
        if (level < 1) throw new TypeError("level must be between 1 and 40");
        const result = await requestNative(target, "levelBounds", { level });
        if (result.ok !== true || !result.bounds || typeof result.bounds !== "object") throw new Error(String(result.detail || `The game could not resolve level ${level}`));
        const points = nonNegative((result.bounds as Record<string, unknown>).start, "level start", config.maximumExperience);
        return mutate(target, "set", points, options);
    }

    async function grantTalent(target: Player | number, rawTalentId: string, rawLevel: number | undefined, options: HmpTalentMutationOptions<Player>) {
        await start();
        const mutation = talentMutation(target, rawTalentId, rawLevel, "owned", "grant", options);
        const result = await repository.mutateTalent(mutation);
        const player = await syncOnline(mutation.characterId);
        emit("hmp:progression:talentChanged", { player, talent: result });
        return result;
    }

    async function purchaseTalent(player: Player, rawTalentId: string, options: HmpTalentMutationOptions<Player>) {
        await start();
        const mutation = talentMutation(player, rawTalentId, 1, "owned", "purchase", options);
        const existing = await repository.talent(mutation.characterId, mutation.talentId);
        if (existing?.status === "owned") return existing;
        const current = await repository.profile(mutation.characterId);
        if (current.talentPoints < 1) throw new Error("No Foundations talent points are available");
        const native = await requestNative(player, "purchase", { talentId: mutation.talentId });
        if (native.ok !== true) throw new Error(String(native.detail || "The game refused the talent purchase"));
        try {
            const result = await repository.purchaseTalent(mutation);
            await sync(player);
            emit("hmp:progression:talentChanged", { player: onlinePlayer(mutation.characterId), talent: result, purchased: true });
            return result;
        } catch (error) {
            player.emit!("hmp-progression:request", JSON.stringify({ requestId: "rollback", operation: "remove", talentId: mutation.talentId }));
            throw error;
        }
    }

    async function revokeTalent(target: Player | number, rawTalentId: string, options: HmpTalentMutationOptions<Player>) {
        await start();
        const mutation = talentMutation(target, rawTalentId, 1, "revoked", "grant", options);
        const result = await repository.mutateTalent(mutation);
        const player = await syncOnline(mutation.characterId);
        emit("hmp:progression:talentChanged", { player, talent: result });
        return result;
    }

    async function resetTalents(target: Player | number, options: HmpTalentMutationOptions<Player>): Promise<number> {
        await start();
        if (!options) throw new TypeError("talent mutation options are required");
        const id = characterId(target);
        const changed = await repository.resetTalents(id, { actorCharacterId: actorCharacterId(options.actor), resource: resource(options.resource), reason: reason(options.reason) });
        const player = await syncOnline(id);
        if (changed) emit("hmp:progression:talentsReset", { player, characterId: id, count: changed });
        return changed;
    }

    async function setTalentPoints(target: Player | number, rawPoints: number, options: HmpTalentMutationOptions<Player>) {
        await start();
        if (!options) throw new TypeError("talent mutation options are required");
        resource(options.resource);
        actorCharacterId(options.actor);
        const id = characterId(target);
        const profile = await repository.setTalentPoints(id, nonNegative(rawPoints, "talent points", config.maximumTalentPoints));
        const player = await syncOnline(id);
        emit("hmp:progression:changed", { player, character: player ? core.characters.active(player) : null, profile });
        return profile;
    }

    async function recover(rawReference: string) {
        await start();
        const id = reference(rawReference);
        const existing = await repository.reward(id);
        if (!existing) throw new Error(`Progression reward '${id}' does not exist`);
        if (existing.status === "failed") throw new Error(`Progression reward '${id}' failed: ${existing.error}`);
        const transaction = existing.status === "completed" ? existing : await repository.applyReward(id, config.maximumExperience);
        pendingTransactions = (await repository.pendingRewards(200)).length;
        const player = onlinePlayer(transaction.characterId);
        if (player) await sync(player);
        return transaction;
    }

    async function characterLoaded(player: Player): Promise<void> {
        try { await sync(player); } catch (error) { logger.warn(`Could not synchronize #${player.id}: ${messageOf(error)}`); }
    }
    async function worldReady(player: Player): Promise<void> { await characterLoaded(player); }
    function disconnect(player: Player): boolean {
        const id = Number(player.id);
        syncedPlayers.delete(id);
        for (const [key, pending] of pendingNative) if (pending.playerId === id) {
            clearTimer(pending.timer); pendingNative.delete(key); pending.reject(new Error("Player disconnected"));
        }
        return true;
    }
    async function stop(): Promise<void> {
        state = "stopped"; syncedPlayers.clear();
        for (const [key, pending] of pendingNative) { clearTimer(pending.timer); pending.reject(new Error("hmp-progression stopped")); pendingNative.delete(key); }
    }

    return Object.freeze({
        progression: Object.freeze({
            get: async (target: Player | number) => { await start(); return repository.profile(characterId(target)); },
            add: (target: Player | number, points: number, options: HmpProgressionMutationOptions<Player>) => mutate(target, "add", points, options),
            set: (target: Player | number, points: number, options: HmpProgressionMutationOptions<Player>) => mutate(target, "set", points, options),
            setLevel,
            transaction: async (rawReference: string) => { await start(); return repository.reward(reference(rawReference)); },
            history: async (id: number, rawLimit = 50) => { await start(); return repository.rewardHistory(positiveId(id, "character id"), limit(rawLimit)); },
            pending: async (rawLimit = 50) => { await start(); const rows = await repository.pendingRewards(limit(rawLimit)); pendingTransactions = rows.length; return rows; },
            recover, sync,
        }),
        talents: Object.freeze({
            list: async (target: Player | number, includeRevoked = false) => { await start(); return repository.talents(characterId(target), includeRevoked); },
            grant: grantTalent, purchase: purchaseTalent, revoke: revokeTalent, reset: resetTalents, setPoints: setTalentPoints,
        }),
        status: () => ({ state, lastError, syncedPlayers: syncedPlayers.size, pendingTransactions, pendingNativeRequests: pendingNative.size, uptimeMs: Math.max(0, now() - startedAt) }),
        start, characterLoaded, worldReady, nativeReport, nativeResult, disconnect, stop,
    });
}

export = { createProgressionService, payloadObject };
