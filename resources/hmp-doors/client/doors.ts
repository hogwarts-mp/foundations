import type { HmpResolvedDoorPolicy } from "../types";

/**
 * `path` and `x`/`y`/`z` arrive only from client builds carrying the door-position change; older ones
 * omit them. `name` is an actor `FName`, unique only within its Outer, so streamed sublevels can repeat
 * it — `path` carries the outer chain and is what separates two placements sharing a name.
 */
interface NativeDoor { name: string; cls: string; dist: number; bearing: number; path?: string; x?: number; y?: number; z?: number }

interface NativeDoors {
    setLock(lockId: string, unlocked?: boolean): boolean;
    superAlohomora(enable?: boolean): boolean;
    list(radius?: number): NativeDoor[];
    openNearby(radius?: number): number;
    unlockNearby(radius?: number): number;
    setOpen(name: string, open?: boolean): boolean;
    setLocked(selector: string, locked?: boolean): number;
    setPolicy(policy: { unlockAll?: boolean; unlockDoors?: string[]; unlockAllExcept?: string[]; lockDoors?: string[] }): void;
}

interface Vec3Like { x: number; y: number; z: number }
interface RotatorLike { pitch: number; yaw: number; roll: number }

interface NativeHud {
    showPrompt(key: string, label: string, x: number, y: number, z: number): void;
    hidePrompt(): void;
}

interface NativeLocalPlayer {
    getPosition(): Vec3Like | null;
    getRotation(): RotatorLike | null;
}

interface NativeTimers {
    setInterval(handler: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
}

interface DoorLabelOptions {
    radius: number;
    intervalMs: number;
    offsetZ: number;
}

interface ClientDependencies {
    doors: NativeDoors;
    events: { emitServer(eventName: string, payload?: unknown): void };
    hud?: NativeHud;
    localPlayer?: NativeLocalPlayer;
    timers?: NativeTimers;
    notify?(message: string): void;
    log?(message: string): void;
}

const LABEL_DEFAULTS: DoorLabelOptions = { radius: 1500, intervalMs: 250, offsetZ: 120 };

/** How many of the nearest doors `list` echoes into chat; the console still gets every one. */
const CHAT_ROWS = 5;

function parsePayload(raw: unknown): Record<string, unknown> {
    if (typeof raw === "string") {
        try { return JSON.parse(raw) as Record<string, unknown>; }
        catch (_) { return {}; }
    }
    return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && !!entry.trim()).map((entry) => entry.trim()))] : [];
}

function normalizePolicy(raw: unknown): HmpResolvedDoorPolicy {
    const value = parsePayload(raw);
    return {
        unlockAll: value.unlockAll === true,
        unlockDoors: stringList(value.unlockDoors),
        unlockAllExcept: stringList(value.unlockAllExcept),
        lockDoors: stringList(value.lockDoors),
        unlockLocks: stringList(value.unlockLocks),
        superAlohomora: value.superAlohomora === true,
    };
}

function normalizeLabelOptions(raw: unknown): DoorLabelOptions {
    const value = parsePayload(raw);
    const offsetZ = Number(value.offsetZ);
    return {
        radius: Math.max(100, Math.min(20000, Number(value.radius) || LABEL_DEFAULTS.radius)),
        intervalMs: Math.max(50, Math.min(2000, Number(value.intervalMs) || LABEL_DEFAULTS.intervalMs)),
        offsetZ: Number.isFinite(offsetZ) ? offsetZ : LABEL_DEFAULTS.offsetZ,
    };
}

/**
 * The shortest piece of a door's path that still tells two same-named placements apart: the package,
 * which is everything before the first ".", reduced to its last "/" segment. Returns "" for a path
 * that is absent or not shaped that way, and callers fall back to the bare name.
 */
function levelSegment(path: string | undefined): string {
    if (typeof path !== "string" || !path) return "";
    const pkg = path.split(".")[0] || "";
    return pkg.slice(pkg.lastIndexOf("/") + 1);
}

/** A door the native located, so its own world position can be used instead of a reconstruction. */
function isLocated(door: NativeDoor): door is NativeDoor & { x: number; y: number; z: number } {
    return Number.isFinite(door.x) && Number.isFinite(door.y) && Number.isFinite(door.z);
}

/**
 * Prefers the door's own position. Falling back, the mod computes `bearing` as `atan2(dy, dx) - yaw`
 * (`BearingDeg` in its `builtins/doors.cpp`), which adding the yaw back inverts exactly, but a
 * straight-line `dist` then stands in for a ground-plane radius and the player Z for the door's own.
 */
function doorAnchor(origin: Vec3Like, yaw: number, door: NativeDoor, options: DoorLabelOptions): Vec3Like {
    if (isLocated(door)) return { x: door.x, y: door.y, z: door.z + options.offsetZ };
    const radians = ((door.bearing + yaw) * Math.PI) / 180;
    return { x: origin.x + door.dist * Math.cos(radians), y: origin.y + door.dist * Math.sin(radians), z: origin.z + options.offsetZ };
}

/**
 * `Doors.list` reports dist -1 for an actor it could not locate and bearing 999 when the player
 * rotation was unavailable. A located door survives an unusable bearing, since reconstruction is
 * then the only thing that needed the yaw.
 */
function isAnchorable(door: NativeDoor, hasYaw: boolean): boolean {
    if (typeof door.name !== "string" || !door.name) return false;
    if (typeof door.dist !== "number" || !Number.isFinite(door.dist) || door.dist < 0) return false;
    if (isLocated(door)) return true;
    return hasYaw && Number.isFinite(door.bearing) && Math.abs(door.bearing) <= 180;
}

function createDoorClient(dependencies: ClientDependencies) {
    const { doors } = dependencies;
    let current = normalizePolicy({});
    let ready = false;
    let stopped = false;
    let labelOptions: DoorLabelOptions | null = null;
    let labelHandle: unknown = null;
    let labelSignature = "";

    function apply(raw: unknown): HmpResolvedDoorPolicy {
        if (stopped) return current;
        const next = normalizePolicy(raw);
        const nextLocks = new Set(next.unlockLocks);
        for (const lockId of current.unlockLocks) if (!nextLocks.has(lockId)) doors.setLock(lockId, false);
        for (const lockId of next.unlockLocks) doors.setLock(lockId, true);
        doors.superAlohomora(next.superAlohomora);
        doors.setPolicy({ unlockAll: next.unlockAll, unlockDoors: next.unlockDoors, unlockAllExcept: next.unlockAllExcept, lockDoors: next.lockDoors });
        current = next;
        ready = true;
        return current;
    }

    function list(radius: number = 3000) {
        const bounded = Math.max(100, Math.min(20000, Number(radius) || 3000));
        const found = doors.list(bounded);
        dependencies.log?.(`[hmp-doors] ${found.length} door(s) within ${bounded}cm (distance | bearing | name):`);
        for (const door of found) dependencies.log?.(`  ${door.dist.toFixed(0)}cm | ${door.bearing.toFixed(0)}deg | ${door.name} [${door.cls}]${door.path ? `\n      ${door.path}` : ""}`);
        // The console cannot be copied from, and a path is the one thing worth copying, so the nearest
        // few also go to chat with each path on its own line to keep a selection clean. The native
        // returns up to 60 sorted by distance; sending them all would bury the chat.
        const shown = found.slice(0, CHAT_ROWS);
        const overflow = found.length - shown.length;
        dependencies.notify?.(`[doors] ${found.length} door(s) within ${bounded}cm${overflow > 0 ? `; nearest ${shown.length} below, ${overflow} more in the console` : ""}`);
        for (const door of shown) {
            dependencies.notify?.(`${door.dist.toFixed(0)}cm ${door.name} [${door.cls}]`);
            if (door.path) dependencies.notify?.(door.path);
        }
        return found;
    }

    function hideLabel(): void {
        if (labelSignature === "") return;
        labelSignature = "";
        dependencies.hud?.hidePrompt();
    }

    /** Labels the nearest door only; `Hud.showPrompt` holds one prompt at a time. */
    function scanLabel(): { name: string; dist: number } | null {
        const { hud, localPlayer } = dependencies;
        if (stopped || !labelOptions || !hud || !localPlayer) { hideLabel(); return null; }
        const origin = localPlayer.getPosition();
        if (!origin) { hideLabel(); return null; }
        const yaw = Number(localPlayer.getRotation()?.yaw);
        const seen = new Map<string, number>();
        let nearest: NativeDoor | null = null;
        for (const door of doors.list(labelOptions.radius)) {
            if (!door || !isAnchorable(door, Number.isFinite(yaw))) continue;
            seen.set(door.name, (seen.get(door.name) || 0) + 1);
            if (!nearest || door.dist < nearest.dist || (door.dist === nearest.dist && door.name < nearest.name)) nearest = door;
        }
        if (!nearest) { hideLabel(); return null; }
        // A bare FName is ambiguous exactly when this scan saw it more than once, and only then is the
        // level worth the extra width in a floating label.
        const segment = (seen.get(nearest.name) || 0) > 1 ? levelSegment(nearest.path) : "";
        const text = segment ? `${nearest.name} (${segment})` : nearest.name;
        const anchor = doorAnchor(origin, Number.isFinite(yaw) ? yaw : 0, nearest, labelOptions);
        // The anchor is derived from the player, so it drifts as they walk. Re-issue per 10cm of drift
        // rather than every tick; the client re-projects a held prompt each frame by itself.
        const signature = `${text}\0${Math.round(anchor.x / 10)}\0${Math.round(anchor.y / 10)}\0${Math.round(anchor.z / 10)}`;
        if (signature !== labelSignature) {
            labelSignature = signature;
            hud.showPrompt(`${(nearest.dist / 100).toFixed(1)}m`, text, anchor.x, anchor.y, anchor.z);
        }
        return { name: nearest.name, dist: nearest.dist };
    }

    function startLabels(raw: unknown): boolean {
        if (stopped) return false;
        if (!dependencies.hud || !dependencies.localPlayer) { dependencies.notify?.("[doors] labels need the Hud and LocalPlayer natives"); return false; }
        const timers = dependencies.timers;
        if (labelHandle !== null && timers) timers.clearInterval(labelHandle);
        labelHandle = null;
        labelOptions = normalizeLabelOptions(raw);
        if (timers) labelHandle = timers.setInterval(() => { scanLabel(); }, labelOptions.intervalMs);
        scanLabel();
        dependencies.notify?.(`[doors] labelling the nearest door within ${labelOptions.radius}cm`);
        return true;
    }

    function stopLabels(): boolean {
        const timers = dependencies.timers;
        if (labelHandle !== null && timers) timers.clearInterval(labelHandle);
        labelHandle = null;
        const wasActive = labelOptions !== null;
        labelOptions = null;
        hideLabel();
        if (wasActive) dependencies.notify?.("[doors] door labels off");
        return wasActive;
    }

    function diagnostic(raw: unknown): number | boolean | unknown[] | { name: string; dist: number } | null {
        const value = parsePayload(raw);
        const action = String(value.action || "");
        const radius = Math.max(100, Math.min(20000, Number(value.radius) || (action === "list" ? 3000 : 1500)));
        if (action === "list") return list(radius);
        if (action === "label") return startLabels(value);
        if (action === "label-off") return stopLabels();
        if (action === "open-nearby") return doors.openNearby(radius);
        if (action === "unlock-nearby") return doors.unlockNearby(radius);
        if (action === "set-open") return doors.setOpen(String(value.name || ""), value.open !== false);
        if (action === "set-locked") return doors.setLocked(String(value.selector || ""), value.locked !== false);
        return false;
    }

    function stop(): void {
        if (stopped) return;
        stopLabels();
        stopped = true;
        for (const lockId of current.unlockLocks) doors.setLock(lockId, false);
        doors.superAlohomora(false);
        doors.setPolicy({ unlockAll: false, unlockDoors: [], unlockAllExcept: [], lockDoors: [] });
        current = normalizePolicy({});
        ready = false;
    }

    dependencies.events.emitServer("hmp-doors:ready");
    return Object.freeze({
        apply, list, diagnostic, stop,
        labels: Object.freeze({ start: startLabels, stop: stopLabels, scan: scanLabel }),
        status: () => ({ ready, stopped, policy: current, labels: labelOptions ? { ...labelOptions } : null }),
    });
}

export = { createDoorClient, normalizePolicy, normalizeLabelOptions, doorAnchor, levelSegment, parsePayload, LABEL_DEFAULTS };
