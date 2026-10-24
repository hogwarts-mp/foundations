import type { HmpInteractClient, HmpInteractionClientZone } from "../types";

interface ClientEvents {
    on(eventName: string, listener: (payload?: unknown) => unknown): void;
    emitServer(eventName: string, payload?: unknown): unknown;
}

interface ClientInput {
    shortcuts: {
        register(definition: {
            resource: string; id: string; key: string; state?: "down" | "up" | "both"; priority?: number;
            when?: () => boolean; handler(key: string, state: "down" | "up"): unknown;
        }): () => boolean;
    };
}

interface ClientHud {
    showPrompt(key: string, label: string, x: number, y: number, z: number): void;
    hidePrompt(): void;
}

interface ClientPlayer {
    getPosition(): { x: number; y: number; z: number } | null;
    anchor?(at: { x: number; y: number; z: number; yaw?: number; camera?: boolean }): boolean;
    releaseAnchor?(exit?: { x: number; y: number; z: number }): boolean;
    playClip?(clipPath?: string, options?: { loop?: boolean; hold?: boolean }): boolean;
}

interface Seat {
    id: string;
    clip?: string;
    exit?: { x: number; y: number; z: number };
}

interface ClientGame {
    areControlsLocked(): boolean;
    notify?(message: string): void;
}

interface ShapeColor { r: number; g: number; b: number; a?: number }

interface ClientShapes {
    create(key: string, shape: { type: "ring"; center: { x: number; y: number; z: number }; radius: number; thickness?: number; color?: ShapeColor }): boolean;
    destroy(key: string): boolean;
    destroyAll(): number;
}

/** Closed-test outline colours: where F works, and where its prompt shows when that is nearer. */
const RADIUS_COLOR: ShapeColor = Object.freeze({ r: 1, g: 0.72, b: 0.18, a: 0.9 });
const PROMPT_COLOR: ShapeColor = Object.freeze({ r: 0.3, g: 0.75, b: 1, a: 0.9 });

interface TimerApi {
    setInterval(handler: () => void, milliseconds: number): ReturnType<typeof setInterval>;
    clearInterval(timer: ReturnType<typeof setInterval>): void;
}

function parse(raw: unknown): Record<string, unknown> {
    if (typeof raw === "string") {
        try { return JSON.parse(raw) as Record<string, unknown>; }
        catch (_) { return {}; }
    }
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function point(raw: unknown): { x: number; y: number; z: number } | undefined {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const coordinates = [value.x, value.y, value.z].map(Number);
    return coordinates.every(Number.isFinite) ? { x: coordinates[0], y: coordinates[1], z: coordinates[2] } : undefined;
}

function zone(raw: unknown): HmpInteractionClientZone | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const value = raw as Record<string, unknown>;
    const position = value.position as Record<string, unknown> | undefined;
    const id = String(value.id || "");
    const label = String(value.label || "").slice(0, 80);
    const coordinates = [position?.x, position?.y, position?.z].map(Number);
    const promptDistance = Number(value.promptDistance);
    const radius = Number(value.radius);
    if (!id || !label || !coordinates.every(Number.isFinite) || !Number.isFinite(promptDistance) || promptDistance <= 0) return null;
    return {
        id,
        label,
        position: { x: coordinates[0], y: coordinates[1], z: coordinates[2] },
        promptDistance,
        promptOffsetZ: Number.isFinite(Number(value.promptOffsetZ)) ? Number(value.promptOffsetZ) : 100,
        priority: Number.isFinite(Number(value.priority)) ? Number(value.priority) : 0,
        ...(Number.isFinite(radius) && radius > 0 ? { radius } : {}),
    };
}

function createInteractClient(options: {
    events: ClientEvents;
    input: ClientInput;
    hud: ClientHud;
    localPlayer: ClientPlayer;
    game: ClientGame;
    /** The host's Shapes; absent on a host without it, where outlines only warn. */
    shapes?: ClientShapes;
    timers?: TimerApi;
    now?: () => number;
}): HmpInteractClient & { receiveSnapshot(payload: unknown): boolean; scan(): HmpInteractionClientZone | null; stop(): boolean } {
    const timers = options.timers || { setInterval, clearInterval };
    const now = options.now || Date.now;
    const zones = new Map<string, HmpInteractionClientZone>();
    let enabled = true;
    let ready = false;
    let revision = -1;
    let active: HmpInteractionClientZone | null = null;
    let promptSignature = "";
    let lastPressAt = 0;
    let stopped = false;
    let seat: Seat | null = null;
    let outlines = false;
    let warnedShapes = false;
    /** Shape key -> what it was drawn as, so a resent snapshot redraws only what changed. */
    const drawn = new Map<string, string>();

    function hide(): void {
        const ownedPrompt = promptSignature !== "";
        active = null;
        promptSignature = "";
        if (ownedPrompt) options.hud.hidePrompt();
    }

    function nearestZone(): HmpInteractionClientZone | null {
        const position = options.localPlayer.getPosition();
        if (!position) return null;
        let nearest: { zone: HmpInteractionClientZone; distance: number } | null = null;
        for (const candidate of zones.values()) {
            const measured = Math.hypot(position.x - candidate.position.x, position.y - candidate.position.y, position.z - candidate.position.z);
            if (measured > candidate.promptDistance) continue;
            if (!nearest || candidate.priority > nearest.zone.priority || (candidate.priority === nearest.zone.priority && (measured < nearest.distance || (measured === nearest.distance && candidate.id < nearest.zone.id)))) {
                nearest = { zone: candidate, distance: measured };
            }
        }
        return nearest?.zone || null;
    }

    function scan(): HmpInteractionClientZone | null {
        if (!enabled || stopped || options.game.areControlsLocked()) { hide(); return null; }
        // A seated player's F stands them up, whichever zone is nearest.
        const current = (seat && zones.get(seat.id)) || nearestZone();
        if (!current) { hide(); return null; }
        active = current;
        const label = seat ? "Stand up" : active.label;
        const signature = `${active.id}\0${label}\0${active.position.x}\0${active.position.y}\0${active.position.z}\0${active.promptOffsetZ}`;
        if (signature !== promptSignature) {
            promptSignature = signature;
            options.hud.showPrompt("F", label, active.position.x, active.position.y, active.position.z + active.promptOffsetZ);
        }
        return active;
    }

    /** The server seated the player after a seat interaction ran; a client that cannot sit hands the seat back. */
    function sit(payload: unknown): boolean {
        const value = parse(payload);
        const id = String(value.id || "");
        const at = point(value.position);
        if (stopped || !id || !at) return false;
        const yaw = typeof value.yaw === "number" && Number.isFinite(value.yaw) ? { yaw: value.yaw } : {};
        let seated = false;
        if (typeof options.localPlayer.anchor === "function") {
            try { seated = options.localPlayer.anchor({ ...at, ...yaw, camera: true }) === true; }
            catch (_) { /* no local pawn while loading */ }
        }
        if (!seated) {
            options.events.emitServer("hmp-interact:stand", JSON.stringify({ id }));
            return false;
        }
        const clip = typeof value.clip === "string" && value.clip ? value.clip : undefined;
        seat = { id, clip, exit: point(value.exit) };
        if (clip) {
            try { options.localPlayer.playClip?.(clip, { loop: false, hold: true }); }
            catch (_) { /* the seat holds without its pose */ }
        }
        scan();
        return true;
    }

    /** Ends the seat this resource holds, whoever released the anchor. */
    function seatEnded(): void {
        const current = seat;
        if (!current) return;
        seat = null;
        if (current.clip) {
            try { options.localPlayer.playClip?.(""); }
            catch (_) { /* no local pawn */ }
        }
        options.events.emitServer("hmp-interact:stand", JSON.stringify({ id: current.id }));
        scan();
    }

    function standUp(): void {
        const current = seat;
        if (!current) return;
        try {
            if (current.exit) options.localPlayer.releaseAnchor?.(current.exit);
            else options.localPlayer.releaseAnchor?.();
        } catch (_) { /* the host already released it */ }
        seatEnded();
    }

    /** Rings each streamed zone's radius, and its prompt distance when nearer, while the server says outlines are on. */
    function outline(): void {
        const shapes = options.shapes;
        if (!outlines || stopped) {
            if (drawn.size && shapes) {
                try { shapes.destroyAll(); }
                catch (_) { /* the host drops a stopped resource's shapes itself */ }
            }
            drawn.clear();
            warnedShapes = false;
            return;
        }
        if (!shapes) {
            if (!warnedShapes) options.game.notify?.("[interact] zone outlines need a HogwartsMP host with Shapes");
            warnedShapes = true;
            return;
        }
        const wanted = new Map<string, { center: HmpInteractionClientZone["position"]; radius: number; color: ShapeColor }>();
        for (const candidate of zones.values()) {
            const radius = candidate.radius ?? candidate.promptDistance;
            wanted.set(`radius:${candidate.id}`, { center: candidate.position, radius, color: RADIUS_COLOR });
            if (candidate.promptDistance < radius) wanted.set(`prompt:${candidate.id}`, { center: candidate.position, radius: candidate.promptDistance, color: PROMPT_COLOR });
        }
        for (const key of [...drawn.keys()]) {
            if (wanted.has(key)) continue;
            try { shapes.destroy(key); }
            catch (_) { /* already gone */ }
            drawn.delete(key);
        }
        for (const [key, ring] of wanted) {
            const signature = `${ring.center.x}\0${ring.center.y}\0${ring.center.z}\0${ring.radius}`;
            if (drawn.get(key) === signature) continue;
            try { shapes.create(key, { type: "ring", center: ring.center, radius: ring.radius, thickness: 6, color: ring.color }); }
            catch (_) { break; /* the host's per-client shape cap: the rest stay undrawn */ }
            drawn.set(key, signature);
        }
    }

    function receiveSnapshot(payload: unknown): boolean {
        const value = parse(payload);
        const nextRevision = Number(value.revision);
        if (!Number.isSafeInteger(nextRevision) || nextRevision < revision || !Array.isArray(value.interactions)) return false;
        const next = new Map<string, HmpInteractionClientZone>();
        for (const raw of value.interactions.slice(0, 5000)) {
            const normalized = zone(raw);
            if (normalized) next.set(normalized.id, normalized);
        }
        zones.clear();
        for (const [id, interaction] of next) zones.set(id, interaction);
        revision = nextRevision;
        ready = true;
        // The seat's interaction went away, or the player left its world or area.
        if (seat && !zones.has(seat.id)) standUp();
        outlines = value.outlines === true;
        outline();
        scan();
        return true;
    }

    function onInteract(): void {
        if (!enabled || stopped || options.game.areControlsLocked()) return;
        const current = scan();
        const time = now();
        if (!current || time - lastPressAt < 250) return;
        lastPressAt = time;
        if (seat) standUp();
        else options.events.emitServer("hmp-interact:trigger", JSON.stringify({ id: current.id, revision }));
    }

    function setEnabled(value: boolean): boolean {
        enabled = value === true;
        if (!enabled) { standUp(); hide(); }
        else scan();
        return enabled;
    }

    function stop(): boolean {
        if (stopped) return false;
        stopped = true;
        standUp();
        outline();
        timers.clearInterval(timer);
        removeShortcut();
        hide();
        zones.clear();
        return true;
    }

    const removeShortcut = options.input.shortcuts.register({
        resource: "hmp-interact", id: "interact", key: "f", state: "down", priority: 0,
        when: () => enabled && !stopped && !options.game.areControlsLocked() && Boolean(scan()),
        handler: () => onInteract(),
    });
    options.events.on("hmp-interact:snapshot", receiveSnapshot);
    options.events.on("hmp-interact:seat", sit);
    // Death, a kneel, a teleport, a server hold or a map load end the anchor without this resource.
    options.events.on("anchorReleased", seatEnded);
    const timer = timers.setInterval(scan, 100);
    options.events.emitServer("hmp-interact:ready", "{}");

    return Object.freeze({
        setEnabled,
        status: () => ({ enabled, ready, revision, interactions: zones.size, active: active?.id || null, outlines }),
        receiveSnapshot,
        scan,
        stop,
    });
}

export = { createInteractClient };
