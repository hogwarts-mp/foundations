import type { HmpControlLease, HmpLibClient } from "../../../../resources/hmp-lib/types";
import type { ConfigureModel, DifficultyPreset, EnemyMenuEntry, HudState } from "../shared/types";

const RESOURCE = "hmp-gauntlet";
const CONFIG_URL = "fw://resources/hmp-gauntlet/dist/config.html";
const HUD_URL = "fw://resources/hmp-gauntlet/dist/hud.html";
const Hmp = Imports.get<HmpLibClient>("hmp-lib");

let menuView = -1;
let menuLease: HmpControlLease | null = null;
let model: ConfigureModel | null = null;
let hudView = -1;
let hudState: HudState = { active: false };

function record(value: unknown): Record<string, unknown> | null {
    if (typeof value === "string") {
        try { return record(JSON.parse(value)); } catch { return null; }
    }
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function finite(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parsePreset(value: unknown): DifficultyPreset | null {
    const source = record(value);
    if (!source) return null;
    return {
        waves: finite(source.waves, 10), baseSpawns: finite(source.baseSpawns, 4),
        spawnGrowth: finite(source.spawnGrowth, 2), hpGrowth: finite(source.hpGrowth, 1.15),
        scaleStep: finite(source.scaleStep, 0.06), scaleMax: finite(source.scaleMax, 1.9),
        bossEvery: finite(source.bossEvery, 5), maxAlive: finite(source.maxAlive, 8),
        intermission: finite(source.intermission, 5),
    };
}

function parseConfigureModel(value: unknown): ConfigureModel | null {
    const source = record(value);
    if (!source) return null;
    const presets = Array.isArray(source.presets)
        ? source.presets.filter((entry): entry is string => typeof entry === "string")
        : [];
    const sourceParams = record(source.presetParams) || {};
    const presetParams: Record<string, DifficultyPreset> = {};
    for (const name of presets) {
        const parsed = parsePreset(sourceParams[name]);
        if (parsed) presetParams[name] = parsed;
    }
    const enemies: EnemyMenuEntry[] = Array.isArray(source.enemies) ? source.enemies.flatMap((entry) => {
        const enemy = record(entry);
        return enemy && typeof enemy.id === "string" ? [{
            id: enemy.id,
            label: typeof enemy.label === "string" ? enemy.label : enemy.id,
            group: typeof enemy.group === "string" ? enemy.group : "Other",
        }] : [];
    }) : [];
    const defaultPreset = typeof source.defaultPreset === "string" && presetParams[source.defaultPreset]
        ? source.defaultPreset
        : presets[0];
    return defaultPreset
        ? { presets, presetParams, defaultPreset, enemies, running: source.running === true }
        : null;
}

function parseHudState(value: unknown): HudState {
    const source = record(value);
    if (!source || source.active !== true) return { active: false };
    return {
        active: true,
        wave: finite(source.wave, 0),
        waves: finite(source.waves, 0),
        enemies: finite(source.enemies, 0),
        score: finite(source.score, 0),
    };
}

function closeMenu(): void {
    menuLease?.release();
    menuLease = null;
    if (menuView < 0) return;
    Web.hideView(menuView);
    Web.destroyView(menuView);
    menuView = -1;
}

function pushMenuModel(): void {
    if (menuView >= 0 && model) Web.emit(menuView, "configure", model);
}

Events.on(`${RESOURCE}:configure`, (value: unknown) => {
    model = parseConfigureModel(value);
    if (!model) { Game.notify("[gauntlet] invalid configuration received"); return; }
    if (model.running) { Game.notify("[gauntlet] a run is already active"); return; }
    if (menuView >= 0) { pushMenuModel(); return; }
    menuView = Web.createView(CONFIG_URL, { visible: false });
    if (menuView < 0) { Game.notify("[gauntlet] menu failed to open"); return; }
    Web.on(menuView, "ready", pushMenuModel);
    Web.on(menuView, "close", closeMenu);
    Web.on(menuView, "start", (payload: unknown) => {
        const data = record(payload);
        if (!data) { Game.notify("[gauntlet] invalid menu selection"); return; }
        Events.emitServer(`${RESOURCE}:start`, JSON.stringify(data));
        closeMenu();
    });
    Web.showView(menuView);
    Web.focusView(menuView);
    menuLease = Hmp.input.controls.acquire({ resource: RESOURCE, id: "configure" });
});

function renderHud(): void {
    if (hudView >= 0) Web.emit(hudView, "hud:update", hudState);
}

function openHud(): void {
    if (hudView >= 0) return;
    hudView = Web.createView(HUD_URL, { visible: false });
    if (hudView < 0) return;
    Web.on(hudView, "ready", renderHud);
    Web.showView(hudView);
}

function closeHud(): void {
    if (hudView < 0) return;
    Web.hideView(hudView);
    Web.destroyView(hudView);
    hudView = -1;
}

Events.on(`${RESOURCE}:hud`, (value: unknown) => {
    hudState = parseHudState(value);
    if (hudState.active) { openHud(); renderHud(); }
    else closeHud();
});

Events.on("resourceStop", (name?: string) => {
    if (!name || name === RESOURCE) { closeMenu(); closeHud(); }
});

console.log("[hmp-gauntlet] client ready");
