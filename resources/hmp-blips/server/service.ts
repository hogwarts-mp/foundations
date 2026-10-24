import normalizeModule = require("../shared/normalize");
import type {
    HmpBlipAudience,
    HmpBlipMarkerDefinition,
    HmpBlipMarkerInfo,
    HmpBlipOwner,
    HmpBlipPlayer,
    HmpBlipPlayerGroupDefinition,
    HmpBlipPlayerGroupInfo,
    HmpBlipPlayerReference,
    HmpBlipSelector,
    HmpBlipsServer,
    HmpBlipWaypoint,
    HmpBlipWaypointShareDefinition,
    HmpBlipWaypointShareInfo,
} from "../types";
import type { BlipCore, BlipEvents, BlipLogger, BlipsConfig } from "./internal";

const { marker: normalizeMarker, owner: normalizeOwner, playerGroup: normalizePlayerGroup } = normalizeModule;

interface ServiceDependencies<P extends HmpBlipPlayer> {
    core: BlipCore<P>;
    config: BlipsConfig;
    players(): P[];
    events: BlipEvents;
    logger: BlipLogger;
    now?: () => number;
    setTimer?: (handler: () => void, delay: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

type NormalizedMarker<P extends HmpBlipPlayer> = HmpBlipMarkerDefinition<P> & { key: string; ttl: number; icon: string; label: string; showOnHud: boolean; showDistance: boolean };
type NormalizedPlayerGroup<P extends HmpBlipPlayer> = HmpBlipPlayerGroupDefinition<P> & { key: string; color: [number, number, number, number] | null; priority: number; sameArea: boolean; sameRegion: boolean; sameVirtualWorld: boolean };

interface MarkerRecord<P extends HmpBlipPlayer> {
    definition: NormalizedMarker<P>;
    viewers: Set<number>;
    expiresAt: number | null;
    timer: ReturnType<typeof setTimeout> | null;
    publishToken: number;
}

interface PlayerGroupRecord<P extends HmpBlipPlayer> {
    definition: NormalizedPlayerGroup<P>;
}

interface WaypointShareRecord<P extends HmpBlipPlayer> extends HmpBlipOwner {
    key: string;
    /** The marker it shows, at the sharer's waypoint. */
    marker: HmpBlipMarkerDefinition<P>;
    playerId: number;
}

const WAYPOINT_ICON = "UI_T_MiniMap_Waypoint";

function createBlipsService<P extends HmpBlipPlayer>(dependencies: ServiceDependencies<P>): HmpBlipsServer<P> & {
    cleanup(resource: string): Promise<number>;
    syncPlayer(player: P): Promise<number>;
    /** A client's `hmp-blips:waypoint` report of its player's own map waypoint. */
    reportWaypoint(player: P, payload: unknown): Promise<boolean>;
    /** The player left: their waypoint and its shares go. */
    disconnect(player: P): void;
    stop(): void;
} {
    const { core, config, events, logger } = dependencies;
    const now = dependencies.now || Date.now;
    const setTimer = dependencies.setTimer || setTimeout;
    const clearTimer = dependencies.clearTimer || clearTimeout;
    const startedAt = now();
    const markers = new Map<string, MarkerRecord<P>>();
    const playerGroups = new Map<string, PlayerGroupRecord<P>>();
    const playerViewTokens = new Map<number, number>();
    const playerReplayTokens = new Map<number, number>();
    const waypoints = new Map<number, HmpBlipWaypoint>();
    const waypointShares = new Map<string, WaypointShareRecord<P>>();
    let stopped = false;

    function connectedPlayers(): P[] {
        return dependencies.players().filter((player) => player?.connected !== false && Number.isSafeInteger(Number(player?.id)));
    }

    function playerById(id: unknown): P | null {
        const value = Number(id);
        if (!Number.isSafeInteger(value)) return null;
        return connectedPlayers().find((player) => Number(player.id) === value) || null;
    }

    function emit(player: P, name: string, payload: unknown): boolean {
        try { player.emit(name, JSON.stringify(payload)); return true; }
        catch (_) { return false; }
    }

    function location(player: P): HogwartsMpPlayerLocation | null {
        if (typeof player.location !== "function") return null;
        try { return player.location(); }
        catch (_) { return null; }
    }

    function sameText(left: string | undefined, right: string | undefined): boolean {
        return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
    }

    function iterable(value: unknown): value is Iterable<unknown> {
        return Boolean(value && typeof value !== "string" && typeof (value as Iterable<unknown>)[Symbol.iterator] === "function");
    }

    async function sourcePlayers(source: unknown, label: string): Promise<P[]> {
        if (source === undefined || source === null || source === "all") return connectedPlayers();
        let value = source;
        if (typeof source === "function") {
            try { value = await source(); }
            catch (error) { logger.warn(`[hmp-blips] ${label} resolver failed closed`, error); return []; }
        }
        if (!iterable(value)) return [];
        const result = new Map<number, P>();
        for (const entry of value) {
            const player = playerById(typeof entry === "object" && entry ? (entry as { id?: unknown }).id : entry);
            if (player) result.set(Number(player.id), player);
        }
        return [...result.values()];
    }

    function selectorObject(value: unknown): value is HmpBlipSelector<P> {
        return Boolean(value && typeof value === "object" && !Array.isArray(value) && !iterable(value));
    }

    async function selectorPlayers(selector: HmpBlipAudience<P> | undefined, label: string): Promise<P[]> {
        if (!selectorObject(selector)) return sourcePlayers(selector, label);
        if (!["players", "groups", "groupMode", "areaId", "regionId", "virtualWorld", "where"].some((key) => key in selector)) return [];
        let candidates = await sourcePlayers(selector.players, label);
        const groups = Array.isArray(selector.groups) ? selector.groups : [];
        if (groups.length) {
            const filtered: P[] = [];
            for (const player of candidates) {
                try {
                    const matches = await Promise.all(groups.map((group) => core.groups.has(player, String(group.key || "").toLowerCase(), Number(group.minimumGrade || 0))));
                    if (selector.groupMode === "all" ? matches.every(Boolean) : matches.some(Boolean)) filtered.push(player);
                } catch (error) {
                    logger.warn(`[hmp-blips] ${label} group resolution failed closed for #${player.id}`, error);
                }
            }
            candidates = filtered;
        }
        if (selector.areaId || selector.regionId) candidates = candidates.filter((player) => {
            const current = location(player);
            if (!current) return false;
            if (selector.areaId && !sameText(selector.areaId, current.areaId)) return false;
            return !selector.regionId || sameText(selector.regionId, current.regionId);
        });
        if (selector.virtualWorld !== undefined) candidates = candidates.filter((player) => Number(player.virtualWorld || 0) === Number(selector.virtualWorld));
        if (selector.where) {
            const filtered: P[] = [];
            for (const player of candidates) {
                try { if (await selector.where(player)) filtered.push(player); }
                catch (error) { logger.warn(`[hmp-blips] ${label} predicate failed closed for #${player.id}`, error); }
            }
            candidates = filtered;
        }
        return candidates;
    }

    function resolveTtl(value: unknown): number {
        const raw = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : config.defaultTtl;
        const requested = raw === 0 ? 0 : Math.min(raw, 2_000_000);
        if (config.maxTtl > 0) return requested === 0 ? config.maxTtl : Math.min(requested, config.maxTtl);
        return requested;
    }

    function markerInfo(record: MarkerRecord<P>): HmpBlipMarkerInfo {
        const value = record.definition;
        return {
            resource: value.resource,
            id: value.id,
            key: value.key,
            kind: value.kind,
            position: { ...value.position },
            radius: value.radius,
            icon: value.icon,
            label: value.label,
            showOnHud: value.showOnHud,
            showDistance: value.showDistance,
            ttl: value.ttl,
            expiresAt: record.expiresAt,
            scoped: value.audience !== undefined || value.areaId !== undefined || value.regionId !== undefined || value.virtualWorld !== undefined,
            areaId: value.areaId,
            regionId: value.regionId,
            virtualWorld: value.virtualWorld,
        };
    }

    function wireMarker(record: MarkerRecord<P>) {
        const value = record.definition;
        return {
            key: value.key,
            kind: value.kind,
            x: value.position.x,
            y: value.position.y,
            z: value.position.z,
            radius: value.radius,
            icon: value.icon,
            label: value.label,
            showOnHud: value.showOnHud,
            showDistance: value.showDistance,
        };
    }

    async function markerViewers(record: MarkerRecord<P>): Promise<P[]> {
        let viewers = await selectorPlayers(record.definition.audience, `marker '${record.definition.key}' audience`);
        const value = record.definition;
        if (value.areaId || value.regionId) viewers = viewers.filter((player) => {
            const current = location(player);
            if (!current) return false;
            if (value.areaId && !sameText(value.areaId, current.areaId)) return false;
            return !value.regionId || sameText(value.regionId, current.regionId);
        });
        if (value.virtualWorld !== undefined) viewers = viewers.filter((player) => Number(player.virtualWorld || 0) === value.virtualWorld);
        return viewers;
    }

    async function publishMarker(record: MarkerRecord<P>): Promise<boolean> {
        const token = ++record.publishToken;
        const viewers = await markerViewers(record);
        if (stopped || markers.get(record.definition.key) !== record || record.publishToken !== token) return false;
        const next = new Set(viewers.map((player) => Number(player.id)));
        for (const oldId of record.viewers) if (!next.has(oldId)) {
            const player = playerById(oldId);
            if (player) emit(player, "hmp-blips:remove", { key: record.definition.key });
        }
        const payload = wireMarker(record);
        for (const player of viewers) emit(player, "hmp-blips:set", payload);
        record.viewers = next;
        return true;
    }

    function disarm(record: MarkerRecord<P>): void {
        if (record.timer) clearTimer(record.timer);
        record.timer = null;
    }

    function removeMarker(rawId: string, rawResource: string): boolean {
        const identity = normalizeOwner({ id: rawId, resource: rawResource });
        const record = markers.get(identity.key);
        if (!record) return false;
        markers.delete(identity.key);
        disarm(record);
        events.emitAllClients("hmp-blips:remove", JSON.stringify({ key: identity.key }));
        return true;
    }

    async function upsertMarker(raw: HmpBlipMarkerDefinition<P>): Promise<HmpBlipMarkerInfo> {
        if (stopped) throw new Error("hmp-blips is stopped");
        const definition = normalizeMarker(raw, resolveTtl) as NormalizedMarker<P>;
        const existing = markers.get(definition.key);
        if (!existing) {
            const owned = [...markers.values()].filter((record) => record.definition.resource === definition.resource).length;
            if (owned >= config.maxMarkersPerResource) throw new Error(`blip resource '${definition.resource}' reached its ${config.maxMarkersPerResource} marker limit`);
        } else disarm(existing);
        const record: MarkerRecord<P> = {
            definition,
            viewers: existing?.viewers || new Set<number>(),
            expiresAt: definition.ttl > 0 ? now() + definition.ttl * 1000 : null,
            timer: null,
            publishToken: existing?.publishToken || 0,
        };
        markers.set(definition.key, record);
        if (definition.ttl > 0) record.timer = setTimer(() => removeMarker(definition.id, definition.resource), Math.ceil(definition.ttl * 1000));
        await publishMarker(record);
        return markerInfo(record);
    }

    function clearMarkers(resource: string): number {
        const normalized = normalizeOwner({ resource, id: "cleanup" }).resource;
        let removed = 0;
        for (const record of [...markers.values()]) if (record.definition.resource === normalized && removeMarker(record.definition.id, normalized)) removed++;
        return removed;
    }

    function getMarker(id: string, resource: string): HmpBlipMarkerInfo | null {
        const record = markers.get(normalizeOwner({ id, resource }).key);
        return record ? markerInfo(record) : null;
    }

    function listMarkers(resource?: string): HmpBlipMarkerInfo[] {
        const normalized = resource ? normalizeOwner({ resource, id: "list" }).resource : "";
        return [...markers.values()]
            .filter((record) => !normalized || record.definition.resource === normalized)
            .map(markerInfo)
            .sort((left, right) => left.key.localeCompare(right.key));
    }

    function pulseMarker(id: string, resource: string, pulse = true): boolean {
        const record = markers.get(normalizeOwner({ id, resource }).key);
        if (!record || record.definition.kind !== "circle") return false;
        for (const viewerId of record.viewers) {
            const player = playerById(viewerId);
            if (player) emit(player, "hmp-blips:pulse", { key: record.definition.key, pulse: pulse !== false });
        }
        return true;
    }

    function playerGroupInfo(record: PlayerGroupRecord<P>): HmpBlipPlayerGroupInfo {
        const value = record.definition;
        return {
            resource: value.resource,
            id: value.id,
            key: value.key,
            color: value.color ? [value.color[0], value.color[1], value.color[2], value.color[3]] : null,
            priority: value.priority,
            scopedSubjects: value.subjects !== undefined,
            scopedAudience: value.audience !== undefined,
            sameArea: value.sameArea,
            sameRegion: value.sameRegion,
            sameVirtualWorld: value.sameVirtualWorld,
        };
    }

    function sharesContext(viewer: P, subject: P, definition: NormalizedPlayerGroup<P>): boolean {
        if (definition.sameVirtualWorld && Number(viewer.virtualWorld || 0) !== Number(subject.virtualWorld || 0)) return false;
        if (!definition.sameArea) return true;
        const viewerLocation = location(viewer);
        const subjectLocation = location(subject);
        if (!viewerLocation || !subjectLocation || !sameText(viewerLocation.areaId, subjectLocation.areaId)) return false;
        return !definition.sameRegion || sameText(viewerLocation.regionId, subjectLocation.regionId);
    }

    async function playerView(viewer: P) {
        const visible = new Set<number>();
        const colors = new Map<number, { color: [number, number, number, number]; priority: number }>();
        for (const record of playerGroups.values()) {
            const definition = record.definition;
            const audience = await selectorPlayers(definition.audience, `player group '${definition.key}' audience`);
            if (!audience.some((player) => Number(player.id) === Number(viewer.id))) continue;
            const subjects = await selectorPlayers(definition.subjects, `player group '${definition.key}' subjects`);
            for (const subject of subjects) {
                const subjectId = Number(subject.id);
                if (subjectId === Number(viewer.id) || !sharesContext(viewer, subject, definition)) continue;
                visible.add(subjectId);
                if (!definition.color) continue;
                const previous = colors.get(subjectId);
                if (!previous || definition.priority > previous.priority) colors.set(subjectId, { color: definition.color, priority: definition.priority });
            }
        }
        return {
            all: config.showAllPlayers,
            visible: [...visible],
            colors: Object.fromEntries([...colors].map(([id, value]) => [id, value.color])),
            houseTint: config.houseTint,
            scale: config.playerBlipScale,
            hideBaseIcon: config.hideBaseIcon,
        };
    }

    async function pushPlayerView(player: P): Promise<boolean> {
        const id = Number(player.id);
        const token = (playerViewTokens.get(id) || 0) + 1;
        playerViewTokens.set(id, token);
        const view = await playerView(player);
        if (stopped || playerViewTokens.get(id) !== token || !playerById(id)) return false;
        return emit(player, "hmp-blips:players", view);
    }

    async function refreshPlayers(player?: P): Promise<number> {
        const targets = player ? [player] : connectedPlayers();
        const results = await Promise.all(targets.map(pushPlayerView));
        return results.filter(Boolean).length;
    }

    async function trackPlayers(raw: HmpBlipPlayerGroupDefinition<P>): Promise<HmpBlipPlayerGroupInfo> {
        if (stopped) throw new Error("hmp-blips is stopped");
        const definition = normalizePlayerGroup(raw) as NormalizedPlayerGroup<P>;
        const record = { definition };
        playerGroups.set(definition.key, record);
        await refreshPlayers();
        return playerGroupInfo(record);
    }

    async function untrackPlayers(id: string, resource: string): Promise<boolean> {
        const key = normalizeOwner({ id, resource }).key;
        if (!playerGroups.delete(key)) return false;
        await refreshPlayers();
        return true;
    }

    async function clearPlayerGroups(resource: string): Promise<number> {
        const normalized = normalizeOwner({ resource, id: "cleanup" }).resource;
        let removed = 0;
        for (const [key, record] of [...playerGroups]) if (record.definition.resource === normalized) {
            playerGroups.delete(key);
            removed++;
        }
        if (removed) await refreshPlayers();
        return removed;
    }

    function getPlayerGroup(id: string, resource: string): HmpBlipPlayerGroupInfo | null {
        const record = playerGroups.get(normalizeOwner({ id, resource }).key);
        return record ? playerGroupInfo(record) : null;
    }

    function listPlayerGroups(resource?: string): HmpBlipPlayerGroupInfo[] {
        const normalized = resource ? normalizeOwner({ resource, id: "list" }).resource : "";
        return [...playerGroups.values()]
            .filter((record) => !normalized || record.definition.resource === normalized)
            .map(playerGroupInfo)
            .sort((left, right) => left.key.localeCompare(right.key));
    }

    async function syncMarkerPlayer(player: P): Promise<number> {
        const id = Number(player.id);
        const token = (playerReplayTokens.get(id) || 0) + 1;
        playerReplayTokens.set(id, token);
        const resolved = await Promise.all([...markers.values()].map(async (record) => ({ record, viewers: await markerViewers(record) })));
        if (stopped || playerReplayTokens.get(id) !== token || !playerById(id)) return 0;
        const visible: unknown[] = [];
        for (const { record, viewers } of resolved) {
            if (markers.get(record.definition.key) !== record) continue;
            const allowed = viewers.some((viewer) => Number(viewer.id) === id);
            if (allowed) { visible.push(wireMarker(record)); record.viewers.add(id); }
            else record.viewers.delete(id);
        }
        emit(player, "hmp-blips:replay", { blips: visible });
        return visible.length;
    }

    async function syncPlayer(player: P): Promise<number> {
        const count = await syncMarkerPlayer(player);
        await pushPlayerView(player);
        return count;
    }

    async function syncMarkers(player?: P): Promise<number> {
        if (player) { await syncMarkerPlayer(player); return 1; }
        const targets = connectedPlayers();
        await Promise.all(targets.map(syncMarkerPlayer));
        return targets.length;
    }

    // A client's report is { waypoint: { x, y, z, target } | null }; undefined for anything else.
    function reportedWaypoint(payload: unknown): HmpBlipWaypoint | null | undefined {
        let value = payload;
        if (typeof payload === "string") {
            try { value = JSON.parse(payload); }
            catch (_) { return undefined; }
        }
        if (!value || typeof value !== "object" || !("waypoint" in value)) return undefined;
        const raw = (value as { waypoint: unknown }).waypoint;
        if (raw === null) return null;
        if (!raw || typeof raw !== "object") return undefined;
        const { x, y, z, target } = raw as Record<string, unknown>;
        const point = { x: Number(x), y: Number(y), z: Number(z) };
        if (![point.x, point.y, point.z].every(Number.isFinite)) return undefined;
        const name = typeof target === "string" ? target.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160) : "";
        return { ...point, target: name || null };
    }

    function sameWaypoint(left: HmpBlipWaypoint | null, right: HmpBlipWaypoint | null): boolean {
        if (!left || !right) return left === right;
        return left.x === right.x && left.y === right.y && left.z === right.z && left.target === right.target && left.areaId === right.areaId;
    }

    function getWaypoint(player: HmpBlipPlayerReference<P>): HmpBlipWaypoint | null {
        const waypoint = waypoints.get(Number(typeof player === "object" && player ? player.id : player));
        return waypoint ? { ...waypoint } : null;
    }

    function waypointShareInfo(share: WaypointShareRecord<P>): HmpBlipWaypointShareInfo {
        return { resource: share.resource, id: share.id, key: share.key, playerId: share.playerId, shown: waypoints.has(share.playerId) };
    }

    async function showWaypointShare(share: WaypointShareRecord<P>): Promise<void> {
        const waypoint = waypoints.get(share.playerId);
        if (!waypoint) { removeMarker(share.id, share.resource); return; }
        await upsertMarker({ ...share.marker, position: { x: waypoint.x, y: waypoint.y, z: waypoint.z }, areaId: waypoint.areaId });
    }

    async function reportWaypoint(player: P, payload: unknown): Promise<boolean> {
        const id = Number(player.id);
        let waypoint = reportedWaypoint(payload);
        if (stopped || waypoint === undefined || !playerById(id)) return false;
        // Its coordinates belong to the map the player placed it in.
        const areaId = waypoint ? location(player)?.areaId : undefined;
        if (waypoint && areaId) waypoint = { ...waypoint, areaId };
        const previous = getWaypoint(id);
        if (sameWaypoint(waypoint, previous)) return false;
        if (waypoint) waypoints.set(id, waypoint);
        else waypoints.delete(id);
        events.emit("hmp:blips:waypoint", { player, waypoint: getWaypoint(id), previous });
        for (const share of [...waypointShares.values()]) {
            if (share.playerId !== id) continue;
            try { await showWaypointShare(share); }
            catch (error) { logger.warn(`[hmp-blips] waypoint share '${share.key}' could not follow #${id}`, error); }
        }
        return true;
    }

    async function shareWaypoint(raw: HmpBlipWaypointShareDefinition<P>): Promise<HmpBlipWaypointShareInfo> {
        if (stopped) throw new Error("hmp-blips is stopped");
        const identity = normalizeOwner(raw);
        const player = playerById(typeof raw.player === "object" && raw.player ? raw.player.id : raw.player);
        if (!player) throw new TypeError("waypoint share player must be connected");
        if (raw.audience === undefined) throw new TypeError("waypoint share audience is required");
        const sharer = Number(player.id);
        const audience = raw.audience;
        const marker: HmpBlipMarkerDefinition<P> = {
            resource: identity.resource,
            id: identity.id,
            kind: "marker",
            position: { x: 0, y: 0, z: 0 },
            icon: raw.icon ?? WAYPOINT_ICON,
            label: raw.label ?? player.nickname,
            showOnHud: raw.showOnHud,
            showDistance: raw.showDistance,
            ttl: 0,
            // The sharer has the game's own waypoint already.
            audience: async () => (await selectorPlayers(audience, `waypoint share '${identity.key}' audience`)).filter((viewer) => Number(viewer.id) !== sharer),
        };
        normalizeMarker(marker, resolveTtl);
        const share: WaypointShareRecord<P> = { ...identity, marker, playerId: sharer };
        waypointShares.set(identity.key, share);
        try { await showWaypointShare(share); }
        catch (error) {
            unshareWaypoint(identity.id, identity.resource);
            throw error;
        }
        return waypointShareInfo(share);
    }

    function unshareWaypoint(id: string, resource: string): boolean {
        const share = waypointShares.get(normalizeOwner({ id, resource }).key);
        if (!share) return false;
        waypointShares.delete(share.key);
        removeMarker(share.id, share.resource);
        return true;
    }

    function clearWaypointShares(resource: string): number {
        const normalized = normalizeOwner({ resource, id: "cleanup" }).resource;
        let removed = 0;
        for (const share of [...waypointShares.values()]) if (share.resource === normalized && unshareWaypoint(share.id, share.resource)) removed++;
        return removed;
    }

    function listWaypointShares(resource?: string): HmpBlipWaypointShareInfo[] {
        const normalized = resource ? normalizeOwner({ resource, id: "list" }).resource : "";
        return [...waypointShares.values()]
            .filter((share) => !normalized || share.resource === normalized)
            .map(waypointShareInfo)
            .sort((left, right) => left.key.localeCompare(right.key));
    }

    function disconnect(player: P): void {
        const id = Number(player.id);
        waypoints.delete(id);
        for (const share of [...waypointShares.values()]) if (share.playerId === id) unshareWaypoint(share.id, share.resource);
    }

    async function cleanup(resource: string): Promise<number> {
        const removedMarkers = clearMarkers(resource);
        const removedGroups = await clearPlayerGroups(resource);
        clearWaypointShares(resource); // their markers went with the resource's own
        return removedMarkers + removedGroups;
    }

    function stopService(): void {
        if (stopped) return;
        stopped = true;
        for (const record of markers.values()) disarm(record);
        markers.clear();
        playerGroups.clear();
        waypoints.clear();
        waypointShares.clear();
        events.emitAllClients("hmp-blips:clear", "{}");
        events.emitAllClients("hmp-blips:players", JSON.stringify({ all: true, visible: [], colors: {}, houseTint: true, scale: 1, hideBaseIcon: false }));
    }

    const markerApi = Object.freeze({ upsert: upsertMarker, remove: removeMarker, clear: clearMarkers, get: getMarker, list: listMarkers, pulse: pulseMarker, sync: syncMarkers });
    const playerApi = Object.freeze({ track: trackPlayers, untrack: untrackPlayers, clear: clearPlayerGroups, get: getPlayerGroup, list: listPlayerGroups, refresh: refreshPlayers });
    const waypointApi = Object.freeze({ get: getWaypoint, share: shareWaypoint, unshare: unshareWaypoint, clear: clearWaypointShares, list: listWaypointShares });
    return {
        markers: markerApi,
        players: playerApi,
        waypoints: waypointApi,
        status: () => ({
            state: stopped ? "stopped" : "ready",
            markers: markers.size,
            playerGroups: playerGroups.size,
            expiringMarkers: [...markers.values()].filter((record) => record.expiresAt !== null).length,
            waypoints: waypoints.size,
            waypointShares: waypointShares.size,
            showAllPlayers: config.showAllPlayers,
            uptimeMs: Math.max(0, now() - startedAt),
        }),
        cleanup,
        syncPlayer,
        reportWaypoint,
        disconnect,
        stop: stopService,
    };
}

export = { createBlipsService };
