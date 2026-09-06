import type { HmpControlLease, HmpLibClient } from "../../hmp-lib/types";

const VIEW_URL = "fw://resources/hmp-business/dist/index.html";
const Input = Imports.get<HmpLibClient>("hmp-lib").input;
let view = -1;
let ready = false;
let visible = false;
let model: unknown = null;
let lease: HmpControlLease | null = null;

function parse(payload: unknown): unknown {
    if (typeof payload === "string") { try { return JSON.parse(payload) as unknown; } catch (_) { return {}; } }
    return payload || {};
}

function lock(value: boolean): void {
    if (value && !lease) lease = Input.controls.acquire({ resource: "hmp-business", id: "screen" });
    else if (!value && lease) { lease.release(); lease = null; }
}

function ensureView(): number {
    if (view >= 0) return view;
    try { view = Web.createView(VIEW_URL, { visible: false }); } catch (_) { view = -1; }
    if (view >= 0) {
        Web.on(view, "ready", () => { ready = true; if (visible && model) Web.emit(view, "model", model); });
        Web.on(view, "close", () => Events.emitServer("hmp-business:close", "{}"));
        Web.on(view, "refresh", () => Events.emitServer("hmp-business:refresh", "{}"));
        Web.on(view, "action", (payload) => Events.emitServer("hmp-business:action", typeof payload === "string" ? payload : JSON.stringify(payload || {})));
    }
    return view;
}

function show(payload: unknown): void {
    model = parse(payload);
    if (ensureView() < 0) { Game.notify("[business] The business console is unavailable."); return; }
    visible = true;
    Web.showView(view);
    Web.focusView(view);
    lock(true);
    if (ready) Web.emit(view, "model", model);
}

function hide(): void {
    visible = false;
    if (view >= 0) Web.hideView(view);
    lock(false);
}

Events.on("hmp-business:open", show);
Events.on("hmp-business:model", (payload) => { model = parse(payload); if (visible && ready && view >= 0) Web.emit(view, "model", model); });
Events.on("hmp-business:close", hide);
Events.on("hmp-business:error", (payload) => {
    const value = parse(payload);
    if (visible && ready && view >= 0) Web.emit(view, "actionError", value);
    const message = value && typeof value === "object" && "message" in value ? value.message : "The action could not be completed.";
    Game.notify(`[business] ${String(message)}`);
});

try { Events.emitServer("hmp-business:ready", "{}"); } catch (_) {}
console.info("[hmp-business] client ready");
