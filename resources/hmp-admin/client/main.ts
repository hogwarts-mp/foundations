interface NoclipMovement {
    forward: string;
    back: string;
    left: string;
    right: string;
    up: string;
    down: string;
    boost: string;
}

interface NoclipCommand {
    enabled: boolean;
    speed?: number;
    boost?: number;
    tickMs?: number;
    movement?: NoclipMovement;
}

const DEFAULT_MOVEMENT: NoclipMovement = {
    forward: "w", back: "s", left: "a", right: "d",
    up: "space", down: "ctrl", boost: "shift",
};

let active = false;
let position: HogwartsMpVector3 | null = null;
let movement = DEFAULT_MOVEMENT;
let speed = 4500;
let boost = 3;
let tickMs = 11;
let lastTick = 0;
let flightTimer: ReturnType<typeof setInterval> | null = null;
let landingTimer: ReturnType<typeof setInterval> | null = null;

function parse(raw: unknown): NoclipCommand {
    if (typeof raw === "string") {
        try { return JSON.parse(raw) as NoclipCommand; }
        catch (_) { return { enabled: false }; }
    }
    return raw && typeof raw === "object" ? raw as NoclipCommand : { enabled: false };
}

function keyDown(key: string): boolean {
    try { return Key.isDown(key); }
    catch (_) { return false; }
}

function setProtected(protectedFromDamage: boolean): void {
    try { LocalPlayer.stateInfo.setInvulnerableToDamage(protectedFromDamage); }
    catch (_) { /* no local pawn while loading */ }
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
            const distance = speed * (keyDown(movement.boost) ? boost : 1) * elapsed / magnitude;
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
    tickMs = Math.max(5, Math.trunc(Number(command.tickMs)) || 11);
    position = { x: current.x, y: current.y, z: current.z };
    lastTick = 0;
    active = true;
    LocalPlayer.setCollision(false);
    setProtected(true);
    if (flightTimer) clearInterval(flightTimer);
    flightTimer = setInterval(tick, tickMs);
}

function disable(): void {
    const wasActive = active;
    active = false;
    position = null;
    if (flightTimer) clearInterval(flightTimer);
    flightTimer = null;
    try { LocalPlayer.setCollision(true); }
    catch (_) { /* no local pawn while loading */ }
    if (wasActive) watchForLanding();
    else if (!landingTimer) setProtected(false);
}

function stop(): void {
    active = false;
    position = null;
    if (flightTimer) clearInterval(flightTimer); flightTimer = null;
    if (landingTimer) clearInterval(landingTimer); landingTimer = null;
    try { LocalPlayer.setCollision(true); }
    catch (_) { /* no local pawn while loading */ }
    setProtected(false);
}

Events.on("hmp-admin:noclip", (raw: unknown) => {
    const command = parse(raw);
    if (command.enabled) enable(command); else disable();
});
Events.on("resourceStop", (name?: string) => { if (!name || name === "hmp-admin") stop(); });

console.info("[hmp-admin] no-clip client ready");
