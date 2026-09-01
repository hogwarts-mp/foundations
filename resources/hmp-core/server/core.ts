import type {
    HmpCore,
    HmpCoreCharacter,
    HmpCoreGroup,
    HmpCoreIdentityProvider,
    HmpCorePrincipal,
    HmpCoreSession,
    HmpCoreStatus,
} from "../types";
import type { CoreConfig, CoreOptions, Player, ProviderEntry, Scope } from "./internal";

const IDENTITY_FIELDS: Readonly<Record<string, string>> = Object.freeze({
    steamId: "client-steam",
    discordId: "client-discord",
    hardwareId: "client-hardware",
});

function fail(code: string, message: string): Error & { code: string } {
    const error = new Error(message);
    return Object.assign(error, { code });
}

function playerId(player: Player | number): number {
    const id = Number(player && typeof player === "object" ? player.id : player);
    if (!Number.isSafeInteger(id) || id < 0) throw fail("HMP_CORE_INVALID_PLAYER", "A connected player is required");
    return id;
}

function positiveId(value: unknown, label: string): number {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1) throw fail("HMP_CORE_INVALID_ID", `${label} must be a positive integer`);
    return id;
}

function normalizeKey(value: unknown, label = "key"): string {
    const key = String(value ?? "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.:-]{0,63}$/.test(key)) {
        throw fail("HMP_CORE_INVALID_KEY", `${label} must be 1-64 lowercase letters, numbers, dots, colons, underscores or hyphens`);
    }
    return key;
}

function normalizePrincipal(value: unknown, fallbackTrust = "asserted"): HmpCorePrincipal {
    if (!value || typeof value !== "object") throw fail("HMP_CORE_INVALID_IDENTITY", "Identity provider returned an invalid principal");
    const record = value as Record<string, unknown>;
    const provider = normalizeKey(record.provider, "identity provider");
    const subject = String(record.subject ?? "").trim();
    if (!subject || subject.length > 191) throw fail("HMP_CORE_INVALID_IDENTITY", "Identity subject must be 1-191 characters");
    const trust = String(record.trust || fallbackTrust).trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,15}$/.test(trust)) throw fail("HMP_CORE_INVALID_IDENTITY", "Identity trust must be a short token");
    return Object.freeze({ provider, subject, trust });
}

function createCore(options: CoreOptions) {
    const repository = options.repository;
    const database = options.database;
    const migrations = options.migrations || [];
    const events = options.events || null;
    const listPlayers = options.listPlayers || (() => []);
    const logger = options.logger || console;
    const config = options.config || {};
    if (!repository || !database) throw new TypeError("repository and database are required");

    let state: HmpCoreStatus["state"] = "starting";
    let lastError = "";
    let startedAt = Date.now();
    let startPromise: Promise<boolean> | null = null;
    const sessionsByPlayer = new Map<number, HmpCoreSession<Player>>();
    const sessionsByAccount = new Map<number, HmpCoreSession<Player>>();
    const attempts = new Map<number, symbol>();
    const providers = new Map<string, ProviderEntry>();

    function logError(message: string, error: unknown): void {
        if (logger && typeof logger.error === "function") logger.error(`${message}: ${error instanceof Error ? error.message : String(error)}`);
    }

    async function emit(name: string, payload: unknown): Promise<void> {
        if (!events || typeof events.emit !== "function") return;
        try { await events.emit(name, payload); }
        catch (error) { logError(`[hmp-core] ${name} handler failed`, error); }
    }

    function registerProvider(definition: HmpCoreIdentityProvider<Player>): () => boolean {
        if (!definition || typeof definition.resolve !== "function") throw new TypeError("identity provider resolve must be a function");
        const name = normalizeKey(definition.name, "identity provider name");
        if (providers.has(name)) throw fail("HMP_CORE_PROVIDER_EXISTS", `Identity provider ${name} is already registered`);
        const entry: ProviderEntry = Object.freeze({
            name,
            resource: String(definition.resource || "unknown"),
            priority: Number.isFinite(Number(definition.priority)) ? Number(definition.priority) : 0,
            trust: String(definition.trust || "asserted"),
            resolve: definition.resolve,
        });
        providers.set(name, entry);
        return () => providers.delete(name);
    }

    function unregisterProvider(name: string): boolean {
        return providers.delete(normalizeKey(name, "identity provider name"));
    }

    function removeIdentityProvidersForResource(resource: string): number {
        let removed = 0;
        for (const [name, provider] of providers) {
            if (provider.resource === resource && name !== "hmp-client-identity") {
                providers.delete(name);
                removed += 1;
            }
        }
        return removed;
    }

    async function resolveIdentity(player: Player): Promise<HmpCorePrincipal> {
        const ordered = [...providers.values()].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
        for (const provider of ordered) {
            const result = await provider.resolve(player);
            if (result) return normalizePrincipal(result, provider.trust);
        }
        throw fail("HMP_CORE_IDENTITY_MISSING", "No usable identity was supplied for this player");
    }

    registerProvider({
        name: "hmp-client-identity",
        resource: "hmp-core",
        priority: -1000,
        trust: "asserted",
        resolve(player: Player) {
            for (const field of config.identityOrder || Object.keys(IDENTITY_FIELDS)) {
                const provider = IDENTITY_FIELDS[field];
                const subject = String((player as unknown as Record<string, unknown>)[field] ?? "").trim();
                if (provider && /^\d+$/.test(subject)) return { provider, subject, trust: "asserted" };
            }
            return null;
        },
    });

    function getSession(player: Player | number): HmpCoreSession<Player> | null {
        try { return sessionsByPlayer.get(playerId(player)) || null; }
        catch (_) { return null; }
    }

    function requireSession(player: Player | number): HmpCoreSession<Player> {
        const session = getSession(player);
        if (!session) throw fail("HMP_CORE_SESSION_MISSING", "Player does not have a ready hmp-core session");
        return session;
    }

    async function connect(player: Player): Promise<HmpCoreSession<Player> | null> {
        const id = playerId(player);
        if (startPromise) await startPromise;
        if (state !== "ready") throw fail("HMP_CORE_NOT_READY", `hmp-core is ${state}`);
        if (sessionsByPlayer.has(id)) return sessionsByPlayer.get(id) ?? null;

        const token = Symbol(`connect:${id}`);
        attempts.set(id, token);
        try {
            const principal = await resolveIdentity(player);
            const displayName = String(player.nickname || `Player ${id}`).trim().slice(0, 80) || `Player ${id}`;
            const account = await repository.findOrCreateAccount(principal, displayName);
            if (attempts.get(id) !== token) return null;

            const existing = sessionsByAccount.get(account.id);
            if (existing && existing.playerId !== id) {
                if (config.duplicateSession === "replace-old") {
                    await disconnect(existing.player);
                    if (config.kickDuplicateSession && typeof existing.player?.kick === "function") existing.player.kick("Your account connected from another session.");
                } else {
                    if (config.kickDuplicateSession && typeof player.kick === "function") player.kick("This account is already connected.");
                    throw fail("HMP_CORE_DUPLICATE_SESSION", "This account already has an active session");
                }
            }

            const session = {
                player,
                playerId: id,
                account,
                principal,
                character: null,
                connectedAt: new Date().toISOString(),
            };
            sessionsByPlayer.set(id, session);
            sessionsByAccount.set(account.id, session);
            await emit("hmp:session:ready", session);

            if (config.autoSelectSingleCharacter) {
                const available = await repository.listCharacters(account.id);
                if (available.length === 1) await selectCharacter(player, available[0].id);
            }
            return session;
        } finally {
            if (attempts.get(id) === token) attempts.delete(id);
        }
    }

    async function unloadCharacter(player: Player | number): Promise<HmpCoreCharacter | null> {
        const session = requireSession(player);
        if (!session.character) return null;
        const character = session.character;
        await emit("hmp:character:unloading", { session, character });
        session.character = null;
        await emit("hmp:character:unloaded", { session, character });
        return character;
    }

    async function disconnect(player: Player): Promise<boolean> {
        const id = playerId(player);
        attempts.delete(id);
        const session = sessionsByPlayer.get(id);
        if (!session) return false;
        if (session.character) await unloadCharacter(player);
        sessionsByPlayer.delete(id);
        if (sessionsByAccount.get(session.account.id) === session) sessionsByAccount.delete(session.account.id);
        try { await repository.touchAccount(session.account.id, String(player.nickname || session.account.displayName).slice(0, 80)); }
        catch (error) { logError("[hmp-core] could not update account activity", error); }
        await emit("hmp:session:ended", session);
        return true;
    }

    async function listCharacters(player: Player | number): Promise<HmpCoreCharacter[]> {
        return repository.listCharacters(requireSession(player).account.id);
    }

    async function createCharacter(player: Player | number, input: { name: string; slot?: number }): Promise<HmpCoreCharacter> {
        const session = requireSession(player);
        const name = String(input?.name ?? "").trim().replace(/\s+/g, " ");
        if (name.length < 2 || name.length > 80) throw fail("HMP_CORE_INVALID_CHARACTER", "Character name must be 2-80 characters");
        const existing = await repository.listCharacters(session.account.id);
        if (existing.length >= Number(config.maxCharacters || 4)) throw fail("HMP_CORE_CHARACTER_LIMIT", "Character limit reached");
        const requested = input?.slot === undefined ? null : Number(input.slot);
        const occupied = new Set(existing.map((character) => character.slot));
        const slot = requested === null ? Array.from({ length: Number(config.maxCharacters || 4) }, (_, index) => index + 1).find((value) => !occupied.has(value)) : requested;
        if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 1 || slot > Number(config.maxCharacters || 4) || occupied.has(slot)) {
            throw fail("HMP_CORE_INVALID_CHARACTER_SLOT", "Character slot is unavailable");
        }
        const character = await repository.createCharacter(session.account.id, { name, slot });
        await emit("hmp:character:created", { session, character });
        return character;
    }

    async function selectCharacter(player: Player | number, characterId: number): Promise<HmpCoreCharacter> {
        const session = requireSession(player);
        const character = await repository.findCharacterById(positiveId(characterId, "characterId"));
        if (!character || character.accountId !== session.account.id || character.status !== "active") {
            throw fail("HMP_CORE_CHARACTER_NOT_FOUND", "Character does not belong to this account");
        }
        if (session.character?.id === character.id) return character;
        if (session.character) await unloadCharacter(player);
        await emit("hmp:character:loading", { session, character });
        session.character = character;
        await emit("hmp:character:loaded", { session, character });
        await emit("hmp:character:selected", { session, character });
        return character;
    }

    async function deleteCharacter(player: Player | number, characterId: number): Promise<boolean> {
        const session = requireSession(player);
        const character = await repository.findCharacterById(positiveId(characterId, "characterId"));
        if (!character || character.accountId !== session.account.id || character.status !== "active") {
            throw fail("HMP_CORE_CHARACTER_NOT_FOUND", "Character does not belong to this account");
        }
        if (session.character?.id === character.id) await unloadCharacter(player);
        const deleted = await repository.deleteCharacter(character.id);
        if (deleted) await emit("hmp:character:deleted", { session, character });
        return deleted;
    }

    function normalizeGroup(grade: number, metadata?: Record<string, unknown>): { grade: number; metadata: Record<string, unknown> } {
        const value = Number(grade);
        if (!Number.isSafeInteger(value)) throw fail("HMP_CORE_INVALID_GRADE", "Group grade must be an integer");
        const details = metadata && typeof metadata === "object" ? metadata : {};
        try { JSON.stringify(details); }
        catch (_) { throw fail("HMP_CORE_INVALID_METADATA", "Group metadata must be JSON serializable"); }
        return { grade: value, metadata: details };
    }

    async function effectiveGroups(player: Player | number): Promise<HmpCoreGroup[]> {
        const session = requireSession(player);
        const accountGroups = await repository.listAccountGroups(session.account.id);
        const characterGroups = session.character ? await repository.listCharacterGroups(session.character.id) : [];
        const merged = new Map(accountGroups.map((group) => [group.key, group]));
        for (const group of characterGroups) {
            const current = merged.get(group.key);
            if (!current || group.grade >= current.grade) merged.set(group.key, group);
        }
        return [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
    }

    async function setGroup(scope: Scope, ownerId: number, key: string, grade: number, metadata?: Record<string, unknown>): Promise<HmpCoreGroup> {
        const normalized = normalizeGroup(grade, metadata);
        const group = await repository.setGroup(scope, positiveId(ownerId, `${scope}Id`), normalizeKey(key, "group key"), normalized.grade, normalized.metadata);
        await emit("hmp:groups:changed", { action: "set", ownerId: Number(ownerId), group });
        return group;
    }

    async function removeGroup(scope: Scope, ownerId: number, key: string): Promise<boolean> {
        const id = positiveId(ownerId, `${scope}Id`);
        const normalized = normalizeKey(key, "group key");
        const removed = await repository.removeGroup(scope, id, normalized);
        if (removed) await emit("hmp:groups:changed", { action: "remove", scope, ownerId: id, key: normalized });
        return removed;
    }

    function serializable<T>(value: T): T {
        if (value === undefined) throw fail("HMP_CORE_INVALID_METADATA", "Metadata value cannot be undefined");
        try {
            const json = JSON.stringify(value);
            if (json === undefined) throw new Error("not serializable");
        } catch (_) { throw fail("HMP_CORE_INVALID_METADATA", "Metadata value must be JSON serializable"); }
        return value;
    }

    async function setMetadata<T>(scope: Scope, ownerId: number, key: string, value: T): Promise<T> {
        const id = positiveId(ownerId, `${scope}Id`);
        const normalized = normalizeKey(key, "metadata key");
        const result = await repository.setMetadata(scope, id, normalized, serializable(value));
        await emit("hmp:metadata:changed", { action: "set", scope, ownerId: id, key: normalized, value: result });
        return result;
    }

    async function deleteMetadata(scope: Scope, ownerId: number, key: string): Promise<boolean> {
        const id = positiveId(ownerId, `${scope}Id`);
        const normalized = normalizeKey(key, "metadata key");
        const removed = await repository.deleteMetadata(scope, id, normalized);
        if (removed) await emit("hmp:metadata:changed", { action: "delete", scope, ownerId: id, key: normalized });
        return removed;
    }

    async function start(): Promise<boolean> {
        if (state === "ready") return true;
        if (startPromise) return startPromise;
        state = "starting";
        lastError = "";
        startedAt = Date.now();
        startPromise = (async () => {
            try {
                if (!await database.ready()) throw fail("HMP_CORE_DATABASE_UNAVAILABLE", "hmp-mysql is not ready");
                await database.migrate("hmp-core", migrations);
                state = "ready";
                const players = listPlayers();
                for (const player of Array.isArray(players) ? players : []) connect(player).catch((error) => logError("[hmp-core] existing player setup failed", error));
                return true;
            } catch (error) {
                state = "degraded";
                lastError = error instanceof Error ? error.message : String(error);
                throw error;
            } finally {
                startPromise = null;
            }
        })();
        return startPromise;
    }

    async function stop(): Promise<void> {
        state = "stopped";
        attempts.clear();
        for (const session of [...sessionsByPlayer.values()]) await disconnect(session.player);
    }

    const status = (): HmpCoreStatus => Object.freeze({ state, lastError, sessions: sessionsByPlayer.size, identityProviders: providers.size, uptimeMs: Date.now() - startedAt });
    const identity = Object.freeze({ register: registerProvider, unregister: unregisterProvider, list: () => [...providers.values()].map(({ resolve, ...entry }) => entry), resolve: resolveIdentity });
    const accounts = Object.freeze({
        getByPlayer: (player: Player | number) => getSession(player)?.account || null,
        getById: (id: number) => repository.findAccountById(positiveId(id, "accountId")),
        linkIdentity: (id: number, principal: HmpCorePrincipal) => repository.linkIdentity(positiveId(id, "accountId"), normalizePrincipal(principal)),
    });
    const sessions = Object.freeze({ get: getSession, all: () => [...sessionsByPlayer.values()], isReady: (player: Player | number) => Boolean(getSession(player)) });
    const characters = Object.freeze({
        list: listCharacters,
        create: createCharacter,
        select: selectCharacter,
        active: (player: Player | number) => getSession(player)?.character || null,
        unload: unloadCharacter,
        delete: deleteCharacter,
        limit: () => Number(config.maxCharacters || 4),
    });
    const groups = Object.freeze({
        listAccount: (id: number) => repository.listAccountGroups(positiveId(id, "accountId")),
        listCharacter: (id: number) => repository.listCharacterGroups(positiveId(id, "characterId")),
        effective: effectiveGroups,
        async has(player: Player | number, key: string, minimumGrade = 0) {
            const grade = Number(minimumGrade);
            if (!Number.isSafeInteger(grade)) throw fail("HMP_CORE_INVALID_GRADE", "Minimum group grade must be an integer");
            return (await effectiveGroups(player)).some((group) => group.key === normalizeKey(key, "group key") && group.grade >= grade);
        },
        setAccount: (id: number, key: string, grade: number, metadata?: Record<string, unknown>) => setGroup("account", id, key, grade, metadata),
        setCharacter: (id: number, key: string, grade: number, metadata?: Record<string, unknown>) => setGroup("character", id, key, grade, metadata),
        removeAccount: (id: number, key: string) => removeGroup("account", id, key),
        removeCharacter: (id: number, key: string) => removeGroup("character", id, key),
    });
    const metadata = Object.freeze({
        getAccount: (id: number, key: string) => repository.getMetadata("account", positiveId(id, "accountId"), normalizeKey(key, "metadata key")),
        getCharacter: (id: number, key: string) => repository.getMetadata("character", positiveId(id, "characterId"), normalizeKey(key, "metadata key")),
        setAccount: <T>(id: number, key: string, value: T) => setMetadata("account", id, key, value),
        setCharacter: <T>(id: number, key: string, value: T) => setMetadata("character", id, key, value),
        deleteAccount: (id: number, key: string) => deleteMetadata("account", id, key),
        deleteCharacter: (id: number, key: string) => deleteMetadata("character", id, key),
    });

    return Object.freeze({ status, identity, accounts, sessions, characters, groups, metadata, start, stop, connect, disconnect, removeIdentityProvidersForResource });
}

export = { createCore, normalizePrincipal };
// TypeScript source.
