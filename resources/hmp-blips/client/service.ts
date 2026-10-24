import type { HmpBlipsClient } from "../types";
import type { ClientLogger, NativeClientBlips } from "./internal";

interface ClientDependencies {
    native: NativeClientBlips;
    logger: ClientLogger;
    /** Sends the player's own map waypoint to the server. */
    emitServer?: (eventName: string, payload: string) => void;
    now?: () => number;
}

interface WireMarker {
    key: string;
    kind: "marker" | "circle";
    x: number;
    y: number;
    z: number;
    radius?: number;
    icon?: string;
    label?: string;
    showOnHud?: boolean;
    showDistance?: boolean;
}

function objectPayload(payload: unknown): Record<string, unknown> | null {
    try {
        const parsed = typeof payload === "string" ? JSON.parse(payload) as unknown : payload;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch (_) { return null; }
}

function createBlipsClient(dependencies: ClientDependencies): HmpBlipsClient & {
    set(payload: unknown): boolean;
    remove(payload: unknown): boolean;
    replay(payload: unknown): number;
    clear(): number;
    pulse(payload: unknown): boolean;
    setPlayers(payload: unknown): boolean;
    /** A waypointChanged waypoint, or Blips.waypoint() at start: reported to the server. */
    reportWaypoint(waypoint: unknown): boolean;
    stop(): void;
} {
    const { native, logger } = dependencies;
    const now = dependencies.now || Date.now;
    const startedAt = now();
    const markerKeys = new Set<string>();
    let coloredPlayers = new Set<number>();
    let tracksAll = true;
    let stopped = false;

    function marker(payload: unknown): WireMarker | null {
        const value = objectPayload(payload);
        if (!value) return null;
        const key = String(value.key || "").trim();
        const kind = value.kind === "circle" ? "circle" : value.kind === "marker" ? "marker" : null;
        const x = Number(value.x), y = Number(value.y), z = Number(value.z);
        if (!key || !kind || ![x, y, z].every(Number.isFinite)) return null;
        return {
            key,
            kind,
            x,
            y,
            z,
            radius: value.radius === undefined ? undefined : Number(value.radius),
            icon: typeof value.icon === "string" ? value.icon : "",
            label: typeof value.label === "string" ? value.label : "",
            showOnHud: value.showOnHud !== false,
            showDistance: value.showDistance !== false,
        };
    }

    function set(payload: unknown): boolean {
        if (stopped) return false;
        const value = marker(payload);
        if (!value) return false;
        const accepted = value.kind === "circle"
            ? Number.isFinite(value.radius) && native.setCircle(value.key, value.x, value.y, value.z, value.radius)
            : native.setMarker(value.key, value.x, value.y, value.z, value.icon || undefined, value.label || undefined, value.showOnHud, value.showDistance);
        if (accepted) markerKeys.add(value.key);
        else logger.warn(`Could not apply ${value.kind} '${value.key}'`);
        return accepted;
    }

    function remove(payload: unknown): boolean {
        const value = objectPayload(payload);
        const key = String(value?.key || "").trim();
        if (!key) return false;
        markerKeys.delete(key);
        return native.remove(key);
    }

    function clear(): number {
        const count = markerKeys.size;
        markerKeys.clear();
        native.clear();
        return count;
    }

    function replay(payload: unknown): number {
        const value = objectPayload(payload);
        if (!value || !Array.isArray(value.blips)) return 0;
        clear();
        let applied = 0;
        for (const entry of value.blips) if (set(entry)) applied++;
        return applied;
    }

    function pulse(payload: unknown): boolean {
        const value = objectPayload(payload);
        const key = String(value?.key || "").trim();
        return Boolean(key && markerKeys.has(key) && native.pulseCircle(key, value?.pulse !== false));
    }

    function setPlayers(payload: unknown): boolean {
        const value = objectPayload(payload);
        if (!value) return false;
        const all = value.all !== false;
        const visible = Array.isArray(value.visible) ? value.visible.map(Number).filter(Number.isSafeInteger) : [];
        const colors = value.colors && typeof value.colors === "object" && !Array.isArray(value.colors) ? value.colors as Record<string, unknown> : {};
        native.setHouseTint(value.houseTint !== false);
        const scale = Number(value.scale);
        native.setBlipScale(Number.isFinite(scale) && scale > 0 ? scale : 1);
        native.hideBaseIcon(value.hideBaseIcon === true);
        if (all) native.trackAllPlayers(true); else native.setTrackedPlayers(visible);
        tracksAll = all;
        const nextColored = new Set<number>();
        for (const [rawId, rawColor] of Object.entries(colors)) {
            const id = Number(rawId);
            if (!Number.isSafeInteger(id) || !Array.isArray(rawColor) || rawColor.length < 3) continue;
            const color = rawColor.map(Number);
            if (!color.slice(0, 4).every(Number.isFinite)) continue;
            native.setPlayerColor(id, color[0], color[1], color[2], color[3] ?? 1);
            nextColored.add(id);
        }
        for (const id of coloredPlayers) if (!nextColored.has(id)) native.setPlayerColor(id);
        coloredPlayers = nextColored;
        return true;
    }

    function reportWaypoint(waypoint: unknown): boolean {
        if (stopped || !dependencies.emitServer) return false;
        const value = waypoint && typeof waypoint === "object" ? waypoint as Record<string, unknown> : null;
        const x = Number(value?.x), y = Number(value?.y), z = Number(value?.z);
        const placed = value && [x, y, z].every(Number.isFinite) ? { x, y, z, target: typeof value.target === "string" && value.target ? value.target : null } : null;
        dependencies.emitServer("hmp-blips:waypoint", JSON.stringify({ waypoint: placed }));
        return true;
    }

    function stop(): void {
        if (stopped) return;
        clear();
        for (const id of coloredPlayers) native.setPlayerColor(id);
        coloredPlayers.clear();
        native.trackAllPlayers(true);
        native.setHouseTint(true);
        native.setBlipScale(1);
        native.hideBaseIcon(false);
        tracksAll = true;
        stopped = true;
    }

    return {
        status: () => ({ state: stopped ? "stopped" : "ready", markers: markerKeys.size, coloredPlayers: coloredPlayers.size, trackAllPlayers: tracksAll, uptimeMs: Math.max(0, now() - startedAt) }),
        set,
        remove,
        replay,
        clear,
        pulse,
        setPlayers,
        reportWaypoint,
        stop,
    };
}

export = { createBlipsClient };
