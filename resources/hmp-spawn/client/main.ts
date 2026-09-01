import type { HmpControlLease, HmpLibClient } from "../../hmp-lib/types";

const VIEW_URL = "fw://resources/hmp-spawn/dist/index.html";
const Input = Imports.get<HmpLibClient>("hmp-lib").input;

let view = -1;
let pageReady = false;
let visible = false;
let controlLease: HmpControlLease | null = null;
let model: unknown = null;
let transition = false;

function lock(locked: boolean): void {
    if (locked && !controlLease) controlLease = Input.controls.acquire({ resource: "hmp-spawn", id: "screen" });
    else if (!locked && controlLease) { controlLease.release(); controlLease = null; }
}

function ensureView(): number {
    if (view >= 0) return view;
    try { view = Web.createView(VIEW_URL, { visible: false }); }
    catch (_) { view = -1; }
    if (view >= 0) {
        Web.on(view, "ready", () => {
            pageReady = true;
            if (visible && model) Web.emit(view, "hmp-spawn:model", model);
        });
        Web.on(view, "select", (payload) => {
            const key = payload && typeof payload === "object" && "key" in payload ? payload.key : undefined;
            if (transition || !key) return;
            Events.emitServer("hmp-spawn:select", JSON.stringify({ key: String(key) }));
        });
    }
    return view;
}

function show(payload: unknown): void {
    model = payload || model || {};
    transition = false;
    if (ensureView() < 0) {
        Game.notify("[spawn] The spawn screen is not ready yet.");
        return;
    }
    visible = true;
    Web.showView(view);
    Web.focusView(view);
    lock(true);
    if (pageReady) Web.emit(view, "hmp-spawn:model", model);
}

function startTransition(): void {
    transition = true;
    visible = false;
    if (view >= 0) Web.hideView(view);
    lock(true);
    try { Camera.fade({ from: 0, to: 1, duration: 0.45, hold: true, fadeAudio: true }); }
    catch (_) { /* controls remain locked even when the presentation API is unavailable */ }
}

function finishTransition(): void {
    transition = false;
    visible = false;
    if (view >= 0) Web.hideView(view);
    try {
        Camera.stopFade();
        Camera.fade({ from: 1, to: 0, duration: 0.75, hold: false, fadeAudio: true });
    } catch (_) {}
    setTimeout(() => lock(false), 800);
}

function failTransition(payload: unknown): void {
    transition = false;
    try { Camera.stopFade(); } catch (_) {}
    const message = payload && typeof payload === "object" && "message" in payload ? payload.message : undefined;
    Game.notify(`[spawn] ${String(message || "The destination could not be loaded.")}`);
    if (model) show(model);
    else lock(false);
}

Events.on("hmp-spawn:open", (payload) => show(payload));
Events.on("hmp-spawn:transition", () => startTransition());
Events.on("hmp-spawn:complete", () => finishTransition());
Events.on("hmp-spawn:failed", (payload) => failTransition(payload));

ensureView();
