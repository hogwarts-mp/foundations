const LAST_LOCATION_KEY = "hmp-spawn:last-location";
const MAX_COORDINATE = 10_000_000;
import type { HmpCoreCharacter, HmpCoreSession } from "../../hmp-core/types";
import type { HmpSpawnLocationDefinition, HmpSpawnLocationInfo, HmpSpawnUiModel } from "../types";
import type {
    CharacterSelectionPayload,
    NormalizedLocation,
    Player,
    SpawnContext,
    SpawnFlowOptions,
    TimerHandle,
} from "./internal";

function spawnError(code: string, message: string): Error & { code: string } {
    const error = new Error(message);
    return Object.assign(error, { code });
}

// Failures spawn() has already sent to the client as hmp-spawn:failed, so callers do not send them twice.
const notifiedFailures = new WeakSet<Error>();
function clientNotified(error: unknown): boolean {
    return error instanceof Error && notifiedFailures.has(error);
}

// A host spawn point is always an Overland position: a load or respawn opens Overland and stands the player on it.
const inOverland = (location: NormalizedLocation): boolean => String(location.areaId || "").toLowerCase() === "overland";
const spawnPoint = (location: NormalizedLocation): HogwartsMpSpawnPoint => ({ position: { x: location.x, y: location.y, z: location.z }, yaw: location.yaw ?? 0 });

function normalizeLocation(value: unknown, options: { key?: string; resource?: string } = {}): NormalizedLocation {
    if (!value || typeof value !== "object") throw spawnError("HMP_SPAWN_INVALID_LOCATION", "Spawn location must be an object");
    const record = value as Record<string, unknown>;
    const key = String(record.key || options.key || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(key) || key === "last") {
        throw spawnError("HMP_SPAWN_INVALID_LOCATION", "Spawn key must be 1-32 lowercase letters, numbers, underscores or hyphens");
    }
    const coordinates = { x: Number(record.x), y: Number(record.y), z: Number(record.z) };
    for (const [axis, coordinate] of Object.entries(coordinates)) {
        if (!Number.isFinite(coordinate) || Math.abs(coordinate) > MAX_COORDINATE) {
            throw spawnError("HMP_SPAWN_INVALID_LOCATION", `Spawn ${axis} coordinate is invalid`);
        }
    }
    const yaw = record.yaw === undefined || record.yaw === null ? undefined : Number(record.yaw);
    if (yaw !== undefined && !Number.isFinite(yaw)) throw spawnError("HMP_SPAWN_INVALID_LOCATION", "Spawn yaw is invalid");
    if (record.snapToGround !== undefined && typeof record.snapToGround !== "boolean") {
        throw spawnError("HMP_SPAWN_INVALID_LOCATION", "Spawn snapToGround must be a boolean");
    }
    const groundSnapDistance = record.groundSnapDistance === undefined ? 2000 : Number(record.groundSnapDistance);
    if (!Number.isFinite(groundSnapDistance) || groundSnapDistance <= 0 || groundSnapDistance > 100000) {
        throw spawnError("HMP_SPAWN_INVALID_LOCATION", "Spawn groundSnapDistance must be greater than 0 and at most 100000 cm");
    }
    const areaId = String(record.areaId || "").trim().slice(0, 128);
    const regionId = String(record.regionId || "").trim().slice(0, 128);
    const destinationId = record.destinationId === null ? null : String(record.destinationId || "").trim().slice(0, 128) || undefined;
    return Object.freeze({
        key,
        label: String(record.label || key).trim().slice(0, 64) || key,
        description: String(record.description || "").trim().slice(0, 160),
        ...coordinates,
        ...(areaId ? { areaId } : {}),
        ...(regionId ? { regionId } : {}),
        ...(destinationId !== undefined ? { destinationId } : {}),
        ...(yaw === undefined ? {} : { yaw }),
        snapToGround: record.snapToGround === true,
        groundSnapDistance,
        resource: String(record.resource || options.resource || "unknown"),
    });
}

function storedLocation(value: unknown): NormalizedLocation | null {
    if (!value || typeof value !== "object") return null;
    try {
        return normalizeLocation({
            key: "saved-location",
            label: "Last Location",
            x: (value as Record<string, unknown>).x,
            y: (value as Record<string, unknown>).y,
            z: (value as Record<string, unknown>).z,
            yaw: (value as Record<string, unknown>).yaw,
            areaId: (value as Record<string, unknown>).areaId,
            regionId: (value as Record<string, unknown>).regionId,
            destinationId: (value as Record<string, unknown>).destinationId,
            snapToGround: true,
            resource: "hmp-spawn",
        });
    } catch (_) {
        return null;
    }
}

function createSpawnFlow(options: SpawnFlowOptions) {
    const core = options.core;
    const events = options.events || null;
    const config = options.config || {};
    const logger = options.logger || console;
    const setTimer = options.setTimer || ((callback: () => void, milliseconds: number): TimerHandle => setTimeout(callback, milliseconds));
    const clearTimer = options.clearTimer || ((timer: TimerHandle) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    if (!core?.sessions || !core?.characters || !core?.metadata) throw new TypeError("hmp-core API is required");

    const locations = new Map<string, NormalizedLocation>();
    const pendingByRequest = new Map<number, SpawnContext>();
    const pendingByPlayer = new Map<number, SpawnContext>();
    const spawnedCharacter = new Map<number, number>();
    const loadingDone = new Set<number>();
    const queuedSelection = new Map<number, CharacterSelectionPayload>();
    const selectorRequests = new Map<number, symbol>();
    // Players whose spawn point hmp-spawn set, so clearing one never touches another resource's.
    const respawnPoints = new Set<number>();

    for (const location of config.locations || []) register({ ...location, resource: "hmp-spawn" });
    if (!locations.has(String(config.defaultLocation || "").toLowerCase())) {
        throw new TypeError(`hmp-spawn default location '${config.defaultLocation}' is not registered`);
    }
    const worldSpawn = config.worldSpawn ? locations.get(String(config.worldSpawn).trim().toLowerCase()) : undefined;
    if (config.worldSpawn && !worldSpawn) throw new TypeError(`hmp-spawn worldSpawn '${config.worldSpawn}' is not registered`);
    if (worldSpawn?.areaId && !inOverland(worldSpawn)) throw new TypeError(`hmp-spawn worldSpawn '${worldSpawn.key}' must be an Overland location`);

    // The connect load stands every player on worldSpawn instead of in the house dormitory. The character, and
    // with it the destination, is chosen only after that load, so the teleport still takes them the rest of the way.
    const world = options.world || null;
    let worldSpawnBefore: HogwartsMpSpawnPoint | null | undefined;
    if (worldSpawn) {
        const before = world?.spawn ?? null;
        if (typeof world?.setSpawn === "function" && world.setSpawn(spawnPoint(worldSpawn))) worldSpawnBefore = before;
        else if (logger && typeof logger.warn === "function") logger.warn(`worldSpawn '${worldSpawn.key}' needs a HogwartsMP host with World.setSpawn; players load into the house dormitory`);
    }

    function idOf(player: Player): number {
        const id = Number(player?.id);
        if (!Number.isSafeInteger(id) || id < 0) throw spawnError("HMP_SPAWN_INVALID_PLAYER", "A connected player is required");
        return id;
    }

    function send(player: Player, event: string, payload: unknown = {}): boolean {
        if (!player || typeof player.emit !== "function") return false;
        player.emit(event, JSON.stringify(payload));
        return true;
    }

    function playerLocation(player: Player): HogwartsMpPlayerLocation | null {
        try { return typeof player.location === "function" ? player.location() : null; }
        catch (_) { return null; }
    }

    // areaId is the coordinate space; regionId is a sub-area that changes as the player walks. A saved
    // position is valid anywhere in its area, so only configured destinations that name a region match it.
    function matchesContext(player: Player, location: NormalizedLocation, matchRegion = true): boolean {
        const regionId = matchRegion ? location.regionId : undefined;
        if (!location.areaId && !regionId) return true;
        const current = playerLocation(player);
        if (!current) return false;
        if (location.areaId && location.areaId.toLowerCase() !== current.areaId.toLowerCase()) return false;
        return !regionId || regionId.toLowerCase() === current.regionId.toLowerCase();
    }

    async function emit(name: string, payload: unknown): Promise<void> {
        if (!events || typeof events.emit !== "function") return;
        try { await events.emit(name, payload); }
        catch (error) {
            if (logger && typeof logger.error === "function") logger.error(`${name} handler failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    function register(definition: HmpSpawnLocationDefinition): () => boolean {
        const location = normalizeLocation(definition, { resource: definition?.resource });
        if (locations.has(location.key)) throw spawnError("HMP_SPAWN_LOCATION_EXISTS", `Spawn location '${location.key}' is already registered`);
        locations.set(location.key, location);
        return () => locations.delete(location.key);
    }

    function unregister(key: string): boolean {
        const normalized = String(key || "").trim().toLowerCase();
        const location = locations.get(normalized);
        if (!location || location.resource === "hmp-spawn") return false;
        return locations.delete(normalized);
    }

    function removeForResource(resource: string): number {
        let removed = 0;
        for (const [key, location] of locations) {
            if (location.resource === resource && location.resource !== "hmp-spawn") {
                locations.delete(key);
                removed += 1;
            }
        }
        return removed;
    }

    function publicLocation(location: NormalizedLocation, kind = "configured"): HmpSpawnLocationInfo {
        return {
            key: location.key,
            label: location.label,
            description: location.description,
            kind,
            ...(location.areaId ? { areaId: location.areaId } : {}),
            ...(location.regionId ? { regionId: location.regionId } : {}),
        };
    }

    function sessionAndCharacter(player: Player): { session: HmpCoreSession<Player>; character: HmpCoreCharacter } {
        const session = core.sessions.get(player);
        const character = core.characters.active(player);
        if (!session || !character) throw spawnError("HMP_SPAWN_CHARACTER_MISSING", "Choose a character before selecting a spawn");
        return { session, character };
    }

    async function lastLocation(characterId: number): Promise<NormalizedLocation | null> {
        if (!config.allowLastLocation) return null;
        return storedLocation(await core.metadata.getCharacter(characterId, LAST_LOCATION_KEY));
    }

    async function available(player: Player): Promise<HmpSpawnLocationInfo[]> {
        const { character } = sessionAndCharacter(player);
        const result: HmpSpawnLocationInfo[] = [];
        const last = await lastLocation(character.id);
        if (last && matchesContext(player, last, false)) result.push(publicLocation({ ...last, key: "last" }, "last"));
        for (const location of locations.values()) if (matchesContext(player, location)) result.push(publicLocation(location));
        return result;
    }

    async function resolve(player: Player, destination: unknown): Promise<NormalizedLocation> {
        const { character } = sessionAndCharacter(player);
        if (typeof destination === "object" && destination) {
            const direct = destination as Record<string, unknown>;
            const resolved = normalizeLocation(destination, { key: String(direct.key || "direct"), resource: "direct" });
            if (!matchesContext(player, resolved)) throw spawnError("HMP_SPAWN_AREA_MISMATCH", "That destination is in a different game area.");
            return resolved;
        }
        const key = String(destination || "").trim().toLowerCase();
        if (key === "last") {
            const saved = await lastLocation(character.id);
            if (saved && matchesContext(player, saved, false)) return { ...saved, key: "last", label: "Last Location" };
            throw spawnError("HMP_SPAWN_LOCATION_MISSING", "No saved location is available for this character");
        }
        const configured = locations.get(key);
        if (!configured) throw spawnError("HMP_SPAWN_LOCATION_MISSING", "That spawn location is no longer available");
        if (!matchesContext(player, configured)) throw spawnError("HMP_SPAWN_AREA_MISMATCH", "That destination is in a different game area.");
        return configured;
    }

    async function open(player: Player): Promise<HmpSpawnUiModel> {
        const { character } = sessionAndCharacter(player);
        const playerId = idOf(player);
        const request = Symbol();
        selectorRequests.set(playerId, request);
        const choices = await available(player);
        const current = playerLocation(player);
        const payload: HmpSpawnUiModel = {
            character: { id: character.id, name: character.name },
            locations: choices,
            defaultLocation: String(config.defaultLocation),
            ...(choices.length ? {} : {
                emptyMessage: current
                    ? "No destinations are configured for your current area. Please contact the server administrator."
                    : "Waiting for your current area to load. Destinations will appear automatically.",
            }),
        };
        // Location reports can race selection, disconnects, or newer refreshes while metadata loads.
        if (selectorRequests.get(playerId) === request && core.characters.active(player)?.id === character.id) {
            send(player, "hmp-spawn:open", payload);
        }
        return payload;
    }

    async function saveSnapshot(player: Player, snapshot: unknown, characterOverride: HmpCoreCharacter | null = null, force = false): Promise<boolean> {
        if (!config.saveLastLocation) return false;
        const character = characterOverride || core.characters.active(player);
        if (!character) return false;
        const id = idOf(player);
        if (!force && spawnedCharacter.get(id) !== character.id) return false;
        const saved = storedLocation(snapshot);
        if (!saved) return false;
        await core.metadata.setCharacter(character.id, LAST_LOCATION_KEY, {
            x: saved.x, y: saved.y, z: saved.z,
            ...(saved.yaw === undefined ? {} : { yaw: saved.yaw }),
            ...(saved.areaId ? { areaId: saved.areaId } : {}),
            ...(saved.regionId ? { regionId: saved.regionId } : {}),
            ...(saved.destinationId !== undefined ? { destinationId: saved.destinationId } : {}),
        });
        return true;
    }

    async function save(player: Player, characterOverride: HmpCoreCharacter | null = null, force = false): Promise<boolean> {
        const location = playerLocation(player);
        if (location) return saveSnapshot(player, location, characterOverride, force);
        if (typeof player.location === "function") return false;
        let position;
        try { position = player.position; }
        catch (_) { return false; }
        return saveSnapshot(player, position, characterOverride, force);
    }

    async function locationChanged(player: Player, current: HogwartsMpPlayerLocation | null, previous: HogwartsMpPlayerLocation | null): Promise<boolean> {
        const saved = await saveSnapshot(player, current || previous);
        if (selectorRequests.has(idOf(player))) await open(player);
        return saved;
    }

    function clearPending(context?: SpawnContext | null): void {
        if (!context) return;
        if (context.timer) clearTimer(context.timer);
        pendingByRequest.delete(context.requestId);
        if (pendingByPlayer.get(context.playerId) === context) pendingByPlayer.delete(context.playerId);
    }

    async function failContext(context: SpawnContext, status: number, message: string): Promise<void> {
        clearPending(context);
        send(context.player, "hmp-spawn:failed", { status, message });
        await emit("hmp:spawn:failed", { session: context.session, character: context.character, location: context.location, status, message });
        if (core.sessions.get(context.player)) await open(context.player);
    }

    // A respawn without a position, like the automatic one after a death, stands the player on their spawn point
    // ahead of World.spawn. respawnAtSpawn makes that the character's Overland landing; null clears it again.
    function holdRespawn(player: Player, at: NormalizedLocation | null): void {
        const id = idOf(player);
        if (typeof player.setSpawn !== "function" || (!at && !respawnPoints.has(id))) return;
        try {
            player.setSpawn(at ? spawnPoint(at) : null);
            if (at) respawnPoints.add(id);
            else respawnPoints.delete(id);
        } catch (error) {
            if (logger && typeof logger.warn === "function") logger.warn(`Could not set #${id}'s spawn point: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async function spawn(player: Player, destination: unknown): Promise<number> {
        const playerId = idOf(player);
        if (pendingByPlayer.has(playerId)) throw spawnError("HMP_SPAWN_IN_PROGRESS", "A spawn is already in progress");
        const { session, character } = sessionAndCharacter(player);
        const location = await resolve(player, destination);
        selectorRequests.delete(playerId);
        send(player, "hmp-spawn:transition", { location: publicLocation(location, location.key === "last" ? "last" : "configured") });
        let requestId: number;
        try {
            requestId = Number(player.teleport(location.x, location.y, location.z, {
                ...(location.yaw === undefined ? {} : { yaw: location.yaw }),
                snapToGround: location.snapToGround,
                groundSnapDistance: location.groundSnapDistance,
            }));
            if (!Number.isSafeInteger(requestId) || requestId < 1) throw spawnError("HMP_SPAWN_TELEPORT_REJECTED", "The streamed teleport was not accepted");
        }
        catch (error) {
            // The transition already faded the screen; release it before any caller reopens selection.
            const failure = error instanceof Error ? error : new Error(String(error));
            send(player, "hmp-spawn:failed", { status: -1, message: failure.message });
            notifiedFailures.add(failure);
            throw failure;
        }
        const context: SpawnContext = { requestId, playerId, player, session, character, location, timer: null };
        context.timer = setTimer(() => {
            failContext(context, 6, "The destination took too long to load.").catch((error) => {
                if (logger && typeof logger.error === "function") logger.error(`Spawn timeout recovery failed: ${error instanceof Error ? error.message : String(error)}`);
            });
        }, Number(config.teleportTimeoutMs || 120000));
        // Not unref'd: each resource runs its own event loop, and libuv skips the timers of a loop with nothing referenced.
        pendingByRequest.set(requestId, context);
        pendingByPlayer.set(playerId, context);
        await emit("hmp:spawn:started", { session, character, location: publicLocation(location), requestId });
        return requestId;
    }

    async function complete(player: Player, requestId: unknown, status: unknown, completion: unknown): Promise<boolean> {
        const context = pendingByRequest.get(Number(requestId));
        if (!context || context.playerId !== idOf(player)) return false;
        clearPending(context);
        if (Number(status) !== 0) {
            await failContext(context, Number(status), "The destination could not be loaded. Choose another location.");
            return false;
        }
        const detail = completion && typeof completion === "object" ? completion as Partial<HogwartsMpTeleportCompletion> : null;
        const destination = detail?.destination;
        const validCompletion = Number(detail?.requestId) === context.requestId
            && Number(detail?.status) === 0
            && destination
            && Number.isFinite(Number(destination.x))
            && Number.isFinite(Number(destination.y))
            && Number.isFinite(Number(destination.z))
            && Number.isFinite(Number(destination.yaw));
        if (!validCompletion || !destination) {
            await failContext(context, 7, "The game did not confirm the final landing position. Choose another location.");
            return false;
        }
        const arrival: NormalizedLocation = {
            ...context.location,
            x: Number(destination.x),
            y: Number(destination.y),
            z: Number(destination.z),
            yaw: Number(destination.yaw),
        };
        const observedLocation = playerLocation(player);
        if (observedLocation) {
            arrival.areaId = observedLocation.areaId;
            arrival.regionId = observedLocation.regionId;
            arrival.destinationId = observedLocation.destinationId;
        }
        spawnedCharacter.set(context.playerId, context.character.id);
        if (config.respawnAtSpawn === true) holdRespawn(player, inOverland(arrival) ? arrival : null);
        if (config.saveLastLocation) {
            await saveSnapshot(player, arrival, context.character, true);
        }
        send(player, "hmp-spawn:complete", { location: publicLocation(arrival), destination, groundSnapped: detail.groundSnapped === true });
        await emit("hmp:spawn:complete", { session: context.session, character: context.character, location: arrival, completion: detail });
        return true;
    }

    async function select(player: Player, key: unknown): Promise<number> {
        return spawn(player, String(key || ""));
    }

    // Without a selector nothing else can land the character: the saved location when it fits the live area,
    // else the default, else the selector, which waits for location context and refreshes as it arrives.
    async function autoSpawn(player: Player, characterId: number): Promise<boolean | number> {
        const last = await lastLocation(characterId);
        const fallback = locations.get(String(config.defaultLocation || "").toLowerCase());
        const key = last && matchesContext(player, last, false) ? "last"
            : fallback && matchesContext(player, fallback) ? fallback.key
                : null;
        if (key) {
            try { return await spawn(player, key); }
            catch (error) {
                if (logger && typeof logger.warn === "function") logger.warn(`Automatic spawn at '${key}' failed, opening selection: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        await open(player);
        return true;
    }

    async function onCharacterSelected(payload: CharacterSelectionPayload): Promise<boolean | number> {
        const player = payload?.session?.player;
        if (!player) return false;
        const id = idOf(player);
        spawnedCharacter.delete(id);
        selectorRequests.delete(id);
        // The previous character's landing is no longer where this one respawns.
        holdRespawn(player, null);
        if (!loadingDone.has(id)) {
            queuedSelection.set(id, payload);
            return false;
        }
        if (config.showSelector === false) return autoSpawn(player, payload.character.id);
        await open(player);
        return true;
    }

    async function onLoadingFinished(player: Player): Promise<boolean | number> {
        const id = idOf(player);
        loadingDone.add(id);
        const queued = queuedSelection.get(id);
        if (!queued) return false;
        queuedSelection.delete(id);
        return onCharacterSelected(queued);
    }

    async function saveAll(players: Player[]): Promise<number> {
        let saved = 0;
        for (const player of Array.isArray(players) ? players : []) {
            try { if (await save(player)) saved += 1; }
            catch (error) {
                if (logger && typeof logger.warn === "function") logger.warn(`Could not save #${player?.id} location: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return saved;
    }

    function disconnect(player: Player): void {
        const id = idOf(player);
        const pending = pendingByPlayer.get(id);
        if (pending) clearPending(pending);
        loadingDone.delete(id);
        queuedSelection.delete(id);
        spawnedCharacter.delete(id);
        selectorRequests.delete(id);
        respawnPoints.delete(id);
    }

    // World.spawn is server-wide, so the one found at start is put back.
    function stop(): void {
        if (worldSpawnBefore !== undefined) world?.setSpawn?.(worldSpawnBefore);
        worldSpawnBefore = undefined;
    }

    const locationApi = Object.freeze({
        register,
        unregister,
        list: () => [...locations.values()].map((location) => publicLocation(location)),
    });
    const ui = Object.freeze({ open });

    return Object.freeze({
        locations: locationApi,
        ui,
        spawn,
        select,
        complete,
        save,
        saveAll,
        onCharacterSelected,
        onLoadingFinished,
        locationChanged,
        removeForResource,
        disconnect,
        stop,
        status: () => ({ locations: locations.size, pending: pendingByRequest.size, spawned: spawnedCharacter.size }),
    });
}

export = { createSpawnFlow, normalizeLocation, clientNotified, LAST_LOCATION_KEY };
// TypeScript source.
