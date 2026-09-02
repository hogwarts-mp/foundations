import clientModule = require("./doors");

declare const Doors: {
    setLock(lockId: string, unlocked?: boolean): boolean;
    superAlohomora(enable?: boolean): boolean;
    list(radius?: number): Array<{ name: string; cls: string; dist: number; bearing: number; path?: string; x?: number; y?: number; z?: number }>;
    openNearby(radius?: number): number;
    unlockNearby(radius?: number): number;
    setOpen(name: string, open?: boolean): boolean;
    setLocked(selector: string, locked?: boolean): number;
    setPolicy(policy: { unlockAll?: boolean; unlockDoors?: string[]; unlockAllExcept?: string[]; lockDoors?: string[] }): void;
};

declare const Hud: {
    showPrompt(key: string, label: string, x: number, y: number, z: number): void;
    hidePrompt(): void;
};

declare const LocalPlayer: {
    getPosition(): { x: number; y: number; z: number } | null;
    getRotation(): { pitch: number; yaw: number; roll: number } | null;
};

const { createDoorClient } = clientModule;
const client = createDoorClient({
    doors: Doors,
    events: Events,
    hud: Hud,
    localPlayer: LocalPlayer,
    timers: { setInterval, clearInterval },
    notify: (message: string) => Game.notify(message),
    log: (message: string) => console.info(message),
});

Exports.register("status", client.status);
Exports.register("list", client.list);
Exports.register("labels", () => client.labels);

Events.on("hmp-doors:policy", client.apply);
Events.on("hmp-doors:diagnostic", client.diagnostic);
Events.on("resourceStop", (name?: string) => {
    if (!name || name === "hmp-doors") client.stop();
});

console.info("[hmp-doors] client door policy coordinator ready");
