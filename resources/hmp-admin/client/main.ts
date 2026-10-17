interface NoclipMovement {
    forward: string;
    back: string;
    left: string;
    right: string;
    up: string;
    down: string;
    boost: string;
    slow: string;
}

interface NoclipCommand {
    enabled: boolean;
    speed?: number;
    boost?: number;
    slow?: number;
    tickMs?: number;
    hideLocal?: boolean;
    movement?: NoclipMovement;
}

const DEFAULT_MOVEMENT: NoclipMovement = {
    forward: "w", back: "s", left: "a", right: "d",
    up: "space", down: "ctrl", boost: "shift", slow: "alt",
};

let active = false;
let position: HogwartsMpVector3 | null = null;
let movement = DEFAULT_MOVEMENT;
let speed = 4500;
let boost = 3;
let slow = 0.25;
let tickMs = 11;
let hiddenLocally = false;
let lastTick = 0;
let flightTimer: ReturnType<typeof setInterval> | null = null;
let landingTimer: ReturnType<typeof setInterval> | null = null;

let inputFrozen = false;

function parse<T extends object>(raw: unknown, fallback: T): T {
    if (typeof raw === "string") {
        try { return JSON.parse(raw) as T; }
        catch (_) { return fallback; }
    }
    return raw && typeof raw === "object" ? raw as T : fallback;
}

// The game keeps one flag, not a count: restore only what we stopped, or we'd undo an emote placement's.
function setInputFrozen(frozen: boolean): void {
    if (!frozen && !inputFrozen) return;
    inputFrozen = frozen;
    try { if (frozen) LocalPlayer.stopPlayerInput(); else LocalPlayer.restorePlayerInput(); }
    catch (_) { /* no local pawn while loading; the server hold still pins them */ }
}

function keyDown(key: string): boolean {
    try { return Key.isDown(key); }
    catch (_) { return false; }
}

function setProtected(protectedFromDamage: boolean): void {
    try { LocalPlayer.stateInfo.setInvulnerableToDamage(protectedFromDamage); }
    catch (_) { /* no local pawn while loading */ }
}

// The platform keeps this choice through respawns and travel, so every way out of no-clip restores it.
function setLocallyHidden(hidden: boolean): void {
    if (hiddenLocally === hidden) return;
    try { LocalPlayer.setVisibility(!hidden); }
    catch (_) { /* hosts before HogwartsMP 1.9 have no self-visibility */ }
    hiddenLocally = hidden;
}

// The game skips a landing's fall damage only after a teleport past 1 m, so it counts a flight of shorter hops as a
// fall and reads the height gained on top of the real drop, which past 16 m kills through the invulnerable flag.
function endFall(): void {
    try { LocalPlayer.resetFall(); }
    catch (_) { /* no local pawn while loading, or a host without resetFall */ }
}

function getViewYaw(): number {
    try {
        const yaw = Number(Camera.capture()?.rotation.yaw);
        if (Number.isFinite(yaw)) return yaw;
    } catch (_) { /* camera capture is unavailable on older clients or while loading */ }

    const yaw = Number(LocalPlayer.getControlRotation()?.yaw);
    return Number.isFinite(yaw) ? yaw : 0;
}

function stopLandingProtection(): void {
    if (landingTimer) clearInterval(landingTimer);
    landingTimer = null;
    setProtected(false);
}

function watchForLanding(): void {
    stopLandingProtection();
    setProtected(true);
    let lastZ: number | null = null;
    let stableTicks = 0;
    let elapsed = 0;
    landingTimer = setInterval(() => {
        elapsed += 100;
        const current = LocalPlayer.getPosition();
        if (current) {
            stableTicks = lastZ !== null && Math.abs(current.z - lastZ) < 2 ? stableTicks + 1 : 0;
            lastZ = current.z;
        }
        if (stableTicks >= 5 || elapsed >= 10000) stopLandingProtection();
    }, 100);
}

function tick(): void {
    if (!active || !position) return;
    try {
        const now = Date.now();
        const elapsed = lastTick ? Math.min(0.05, (now - lastTick) / 1000) : tickMs / 1000;
        lastTick = now;
        const yaw = getViewYaw() * Math.PI / 180;
        const forward = { x: Math.cos(yaw), y: Math.sin(yaw) };
        const right = { x: -Math.sin(yaw), y: Math.cos(yaw) };
        let x = 0; let y = 0; let z = 0;
        if (!Game.areControlsLocked()) {
            if (keyDown(movement.forward)) { x += forward.x; y += forward.y; }
            if (keyDown(movement.back)) { x -= forward.x; y -= forward.y; }
            if (keyDown(movement.right)) { x += right.x; y += right.y; }
            if (keyDown(movement.left)) { x -= right.x; y -= right.y; }
            if (keyDown(movement.up)) z++;
            if (keyDown(movement.down)) z--;
        }
        const magnitude = Math.sqrt(x * x + y * y + z * z);
        if (magnitude > 0) {
            const factor = keyDown(movement.slow) ? slow : keyDown(movement.boost) ? boost : 1;
            const distance = speed * factor * elapsed / magnitude;
            position.x += x * distance; position.y += y * distance; position.z += z * distance;
        }
        setProtected(true);
        LocalPlayer.clearVelocity();
        LocalPlayer.setPosition(position.x, position.y, position.z);
    } catch (error) {
        console.error(`[hmp-admin] No-clip tick failed: ${error instanceof Error ? error.message : String(error)}`);
        disable();
    }
}

function enable(command: NoclipCommand): void {
    const current = LocalPlayer.getPosition();
    if (!current) { Game.notify("No-clip could not start because the local character is unavailable."); return; }
    if (landingTimer) clearInterval(landingTimer); landingTimer = null;
    movement = command.movement || DEFAULT_MOVEMENT;
    speed = Math.max(100, Number(command.speed) || 4500);
    boost = Math.max(1, Number(command.boost) || 3);
    slow = Math.max(0.05, Math.min(1, Number(command.slow) || 0.25));
    tickMs = Math.max(5, Math.trunc(Number(command.tickMs)) || 11);
    position = { x: current.x, y: current.y, z: current.z };
    lastTick = 0;
    active = true;
    LocalPlayer.setCollision(false);
    setProtected(true);
    setLocallyHidden(command.hideLocal === true);
    if (flightTimer) clearInterval(flightTimer);
    flightTimer = setInterval(tick, tickMs);
}

function disable(): void {
    const wasActive = active;
    active = false;
    position = null;
    if (flightTimer) clearInterval(flightTimer);
    flightTimer = null;
    if (wasActive) endFall();
    try { LocalPlayer.setCollision(true); }
    catch (_) { /* no local pawn while loading */ }
    setLocallyHidden(false);
    if (wasActive) watchForLanding();
    else if (!landingTimer) setProtected(false);
}

function stop(): void {
    if (active) endFall();
    active = false;
    position = null;
    if (flightTimer) clearInterval(flightTimer); flightTimer = null;
    if (landingTimer) clearInterval(landingTimer); landingTimer = null;
    try { LocalPlayer.setCollision(true); }
    catch (_) { /* no local pawn while loading */ }
    setLocallyHidden(false);
    setProtected(false);
    setInputFrozen(false);
}

Events.on("hmp-admin:noclip", (raw: unknown) => {
    const command = parse<NoclipCommand>(raw, { enabled: false });
    if (command.enabled) enable(command); else disable();
});
Events.on("hmp-admin:freeze", (raw: unknown) => setInputFrozen(parse<{ frozen?: boolean }>(raw, {}).frozen === true));
Events.on("resourceStop", (name?: string) => { if (!name || name === "hmp-admin") stop(); });

console.info("[hmp-admin] no-clip client ready");
