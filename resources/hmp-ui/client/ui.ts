import normalizeModule = require("../shared/normalize");
import type {
    HmpUiAlert,
    HmpUiClient,
    HmpUiContextMenu,
    HmpUiInputDialog,
    HmpUiInputOptions,
    HmpUiInputResult,
    HmpUiInputValue,
    HmpUiNotification,
    HmpUiProgress,
} from "../types";

const { normalizeNotification, normalizeAlert, normalizeInput, normalizeContext, normalizeProgress, liveField, fieldValue } = normalizeModule;
type RequestKind = "alert" | "input" | "context" | "progress";

interface WebApi {
    createView(url: string, options?: { visible?: boolean; focus?: boolean; zIndex?: number }): number;
    destroyView(id: number): boolean | void;
    showView(id: number): boolean | void;
    hideView(id: number): boolean | void;
    focusView(id: number): boolean | void;
    emit(id: number, eventName: string, payload?: unknown): boolean | void;
    on(id: number, eventName: string, listener: (payload?: unknown) => unknown): void;
}

interface EventsApi {
    emitServer(eventName: string, payload?: unknown): unknown;
}

interface RequestRecord {
    id: string;
    type: RequestKind;
    payload: HmpUiAlert | HmpUiInputDialog | HmpUiContextMenu | HmpUiProgress;
    remote: boolean;
    resolve?: (value: unknown) => void;
    onChange?: (name: string, value: HmpUiInputValue) => void;
}

interface UiClientOptions {
    web: WebApi;
    events: EventsApi;
    url?: string;
    retryMs?: number;
    maxRetries?: number;
    transitionGraceMs?: number;
    setTimer?: typeof setTimeout;
    clearTimer?: typeof clearTimeout;
    game?: { notify(message: string): void };
    input?: { controls: { acquire(owner: { resource: string; id: string }): { release(): boolean } } };
}

function parse(raw: unknown): Record<string, unknown> {
    if (typeof raw === "string") {
        try { return JSON.parse(raw) as Record<string, unknown>; }
        catch (_) { return {}; }
    }
    return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
}

function createUiClient(options: UiClientOptions): HmpUiClient & {
    receiveRequest(raw: unknown): boolean;
    receiveNotification(raw: unknown): boolean;
    receiveClose(raw?: unknown): boolean;
    stop(): void;
} {
    const { web, events } = options;
    const url = options.url || "fw://resources/hmp-ui/dist/index.html";
    const retryMs = options.retryMs ?? 1000;
    const maxRetries = options.maxRetries ?? 20;
    const transitionGraceMs = Math.max(0, Math.trunc(Number(options.transitionGraceMs ?? 160)) || 0);
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    const queue: RequestRecord[] = [];
    const notifications: HmpUiNotification[] = [];
    let view = -1;
    let ready = false;
    let active: RequestRecord | null = null;
    let focused = false;
    let notificationsVisible = false;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let transitionTimer: ReturnType<typeof setTimeout> | null = null;
    let localSequence = 0;
    let stopped = false;
    let controlLease: { release(): boolean } | null = null;

    function scheduleCreate(): void {
        if (stopped || retryTimer) return;
        if (retryCount >= maxRetries) {
            retryCount = 0;
            options.game?.notify("[hmp-ui] The interface is unavailable.");
            for (const record of queue.splice(0)) respond(record, cancelValue(record.type));
            notifications.splice(0);
            return;
        }
        retryTimer = setTimer(() => {
            retryTimer = null;
            retryCount++;
            ensureView();
        }, retryMs);
    }

    function ensureView(): boolean {
        if (view >= 0) return true;
        if (stopped) return false;
        try { view = web.createView(url, { visible: false, focus: false, zIndex: 200 }); }
        catch (_) { view = -1; }
        if (view < 0) { scheduleCreate(); return false; }
        retryCount = 0;
        web.on(view, "ready", () => {
            ready = true;
            for (const notification of notifications.splice(0)) showNotification(notification);
            pump();
        });
        web.on(view, "response", onPageResponse);
        web.on(view, "change", onPageChange);
        web.on(view, "idle", () => {
            notificationsVisible = false;
            if (!active && !transitionTimer) web.hideView(view);
        });
        return true;
    }

    function showNotification(notification: HmpUiNotification): void {
        if (!ensureView()) { notifications.push(notification); return; }
        if (!ready) { notifications.push(notification); return; }
        notificationsVisible = true;
        web.showView(view);
        web.emit(view, "notify", notification);
    }

    function releaseFocus(): void {
        if (view < 0 || !focused) return;
        web.hideView(view);
        focused = false;
        controlLease?.release();
        controlLease = null;
        if (notificationsVisible) web.showView(view);
    }

    function cancelTransition(): void {
        if (!transitionTimer) return;
        clearTimer(transitionTimer);
        transitionTimer = null;
    }

    function endPresentation(id?: string): void {
        cancelTransition();
        const wasFocused = focused;
        releaseFocus();
        if (view < 0) return;
        web.emit(view, "clear", id ? { id } : {});
        if (!wasFocused && !notificationsVisible) web.hideView(view);
    }

    function bridgePresentation(id: string): void {
        cancelTransition();
        if (transitionGraceMs <= 0) { endPresentation(id); return; }
        transitionTimer = setTimer(() => {
            transitionTimer = null;
            if (active || queue.length) { pump(); return; }
            endPresentation(id);
        }, transitionGraceMs);
    }

    function respond(record: RequestRecord, result: unknown): void {
        if (record.remote) events.emitServer("hmp-ui:response", JSON.stringify({ id: record.id, result }));
        else record.resolve?.(result);
    }

    function cancelValue(type: RequestKind): false | null | "cancel" {
        if (type === "progress") return false;
        if (type === "alert") return "cancel";
        return null;
    }

    function finish(result: unknown): boolean {
        if (!active) return false;
        const completed = active;
        active = null;
        respond(completed, result);
        const wasFocused = focused;
        if (wasFocused) bridgePresentation(completed.id);
        else endPresentation(completed.id);
        pump();
        return true;
    }

    function onPageResponse(raw: unknown): boolean {
        const response = parse(raw);
        if (!active || String(response.id || "") !== active.id) return false;
        return finish(response.result);
    }

    // A server dialog's edits go up for the server to validate; a local one's are validated here.
    function onPageChange(raw: unknown): boolean {
        const change = parse(raw);
        if (!active || active.type !== "input" || String(change.id || "") !== active.id) return false;
        const dialog = active.payload as HmpUiInputDialog;
        if (!dialog.live) return false;
        if (active.remote) {
            events.emitServer("hmp-ui:change", JSON.stringify({ id: active.id, name: change.name, value: change.value }));
            return true;
        }
        const field = dialog.fields.find((entry) => entry.name === change.name);
        if (!field || !liveField(field) || !active.onChange) return false;
        let value: HmpUiInputValue;
        try { value = fieldValue(field, change.value); }
        catch (_) { return false; }
        try { active.onChange(field.name, value); }
        catch (_) { /* the caller's handler; the dialog stays open */ }
        return true;
    }

    function pump(): void {
        if (active || !queue.length || !ensureView() || !ready) return;
        cancelTransition();
        active = queue.shift() || null;
        if (!active) return;
        web.showView(view);
        const shouldFocus = active.type !== "progress" || (active.payload as HmpUiProgress).canCancel === true;
        if (shouldFocus && !focused) {
            controlLease = options.input?.controls.acquire({ resource: "hmp-ui", id: "dialog" }) || null;
            web.focusView(view);
            focused = true;
        }
        web.emit(view, "request", { id: active.id, type: active.type, payload: active.payload });
    }

    function enqueue<T>(type: RequestKind, payload: RequestRecord["payload"], onChange?: RequestRecord["onChange"]): Promise<T> {
        const id = `local:${Date.now().toString(36)}:${(++localSequence).toString(36)}`;
        return new Promise<T>((resolve) => {
            queue.push({ id, type, payload, remote: false, resolve: (value) => resolve(value as T), onChange });
            pump();
        });
    }

    function input(raw: HmpUiInputDialog, options?: HmpUiInputOptions): Promise<HmpUiInputResult | null> {
        const onChange = typeof options?.onChange === "function" ? options.onChange : undefined;
        return enqueue<HmpUiInputResult | null>("input", normalizeInput({ ...raw, live: !!onChange }), onChange);
    }

    function normalizeRequest(type: RequestKind, raw: unknown): RequestRecord["payload"] {
        if (type === "alert") return normalizeAlert(raw as HmpUiAlert);
        if (type === "input") return normalizeInput(raw as HmpUiInputDialog);
        if (type === "context") return normalizeContext(raw as HmpUiContextMenu);
        return normalizeProgress(raw as HmpUiProgress);
    }

    function receiveRequest(raw: unknown): boolean {
        const envelope = parse(raw);
        const id = String(envelope.id || "");
        const type = String(envelope.type || "") as RequestKind;
        if (!id || !["alert", "input", "context", "progress"].includes(type)) return false;
        try { queue.push({ id, type, payload: normalizeRequest(type, envelope.payload), remote: true }); }
        catch (_) {
            events.emitServer("hmp-ui:response", JSON.stringify({ id, result: type === "progress" ? false : null }));
            return false;
        }
        pump();
        return true;
    }

    function receiveNotification(raw: unknown): boolean {
        try { showNotification(normalizeNotification(typeof raw === "string" ? parse(raw) as unknown as HmpUiNotification : raw as HmpUiNotification)); return true; }
        catch (_) { return false; }
    }

    // The server stopped waiting for this request (it timed out): drop it unanswered and keep the rest.
    function expire(id: string): boolean {
        if (active?.id === id) {
            active = null;
            endPresentation(id);
            pump();
            return true;
        }
        const index = queue.findIndex((record) => record.id === id);
        if (index < 0) return false;
        queue.splice(index, 1);
        return true;
    }

    function receiveClose(raw?: unknown): boolean {
        const id = String(parse(raw).id || "");
        if (id) return expire(id);
        cancelTransition();
        if (active) {
            const current = active;
            active = null;
            respond(current, cancelValue(current.type));
        }
        for (const record of queue.splice(0)) respond(record, cancelValue(record.type));
        const wasFocused = focused;
        releaseFocus();
        if (view >= 0) {
            web.emit(view, "clear", {});
            if (!wasFocused && !notificationsVisible) web.hideView(view);
        }
        focused = false;
        return true;
    }

    function close(reason = "closed"): boolean {
        return receiveClose({ reason });
    }

    function stop(): void {
        stopped = true;
        receiveClose({ reason: "resource stopped" });
        if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
        cancelTransition();
        if (view >= 0) web.destroyView(view);
        view = -1;
        ready = false;
    }

    return Object.freeze({
        notify(raw: string | HmpUiNotification) { showNotification(normalizeNotification(raw)); return true; },
        alert: (raw: HmpUiAlert) => enqueue<"confirm" | "cancel" | null>("alert", normalizeAlert(raw)),
        input,
        context: (raw: HmpUiContextMenu) => enqueue<string | null>("context", normalizeContext(raw)),
        progress: (raw: HmpUiProgress) => enqueue<boolean>("progress", normalizeProgress(raw)),
        close,
        status: () => ({ ready, queued: queue.length, active: active?.type || null, notificationsVisible }),
        receiveRequest,
        receiveNotification,
        receiveClose,
        stop,
    });
}

export = { createUiClient, parse };
