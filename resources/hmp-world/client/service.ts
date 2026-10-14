import type { HmpWorldClientPolicy } from "../types";

interface NativeWorld {
    setBoundaryPolicy(remove: boolean): number;
    setAmbientPopulation(enabled: boolean): boolean;
}

interface ClientOptions {
    native: NativeWorld;
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
    return {
        removeBoundaryVolumes: policy.removeBoundaryVolumes,
        ambientPopulation: policy.ambientPopulation,
    };
}

function createWorldClient(options: ClientOptions) {
    const { native } = options;
    let state: "ready" | "stopped" = "ready";
    let currentPolicy: HmpWorldClientPolicy | null = null;
    let boundaryVolumesChanged = 0;

    function apply(raw: unknown): boolean {
        if (state === "stopped") return false;
        const next = parsePolicy(raw);
        if (!next) return false;
        boundaryVolumesChanged = native.setBoundaryPolicy(next.removeBoundaryVolumes);
        native.setAmbientPopulation(next.ambientPopulation);
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
