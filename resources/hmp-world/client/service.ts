import type { HmpWorldClientPolicy } from "../types";

interface NativeWorld {
    setBoundaryPolicy(remove: boolean): number;
    setAmbientPopulation(enabled: boolean): boolean;
}

// Absent on a host older than per-resource jump and sprint holds.
interface NativePlayer {
    setJumpEnabled?(enabled: boolean): void;
    setSprintEnabled?(enabled: boolean): void;
}

interface ClientOptions {
    native: NativeWorld;
    player: NativePlayer;
    emitReady(): void;
}

function parsePolicy(raw: unknown): HmpWorldClientPolicy | null {
    let value: unknown = raw;
    if (typeof value === "string") {
        try { value = JSON.parse(value); }
        catch (_) { return null; }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const policy = value as Record<string, unknown>;
    if (typeof policy.removeBoundaryVolumes !== "boolean" || typeof policy.ambientPopulation !== "boolean") return null;
    if (typeof policy.jump !== "boolean" || typeof policy.sprint !== "boolean") return null;
    return {
        removeBoundaryVolumes: policy.removeBoundaryVolumes,
        ambientPopulation: policy.ambientPopulation,
        jump: policy.jump,
        sprint: policy.sprint,
    };
}

function createWorldClient(options: ClientOptions) {
    const { native, player } = options;
    let state: "ready" | "stopped" = "ready";
    let currentPolicy: HmpWorldClientPolicy | null = null;
    let boundaryVolumesChanged = 0;

    function apply(raw: unknown): boolean {
        if (state === "stopped") return false;
        const next = parsePolicy(raw);
        if (!next) return false;
        boundaryVolumesChanged = native.setBoundaryPolicy(next.removeBoundaryVolumes);
        native.setAmbientPopulation(next.ambientPopulation);
        // Only hmp-world's own hold: another resource's stays, and the host drops ours when hmp-world stops.
        player.setJumpEnabled?.(next.jump);
        player.setSprintEnabled?.(next.sprint);
        currentPolicy = next;
        return true;
    }

    function restore(): boolean {
        return currentPolicy ? apply(currentPolicy) : false;
    }

    function stop(): void {
        if (state === "stopped") return;
        state = "stopped";
        currentPolicy = null;
    }

    const client = Object.freeze({
        apply,
        stop,
        policy: Object.freeze({ current: () => currentPolicy ? { ...currentPolicy } : null, restore }),
        status: () => ({ state, policy: currentPolicy ? { ...currentPolicy } : null, boundaryVolumesChanged }),
    });
    options.emitReady();
    return client;
}

export = { createWorldClient, parsePolicy };
