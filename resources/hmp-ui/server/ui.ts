import normalizeModule = require("../shared/normalize");
import type {
    HmpUiAlert,
    HmpUiContextMenu,
    HmpUiInputDialog,
    HmpUiInputOptions,
    HmpUiInputResult,
    HmpUiInputValue,
    HmpUiNotification,
    HmpUiPlayer,
    HmpUiProgress,
    HmpUiServer,
} from "../types";

const { clean, normalizeNotification, normalizeAlert, normalizeInput, normalizeContext, normalizeProgress, liveField, fieldValue } = normalizeModule;
type RequestKind = "alert" | "input" | "context" | "progress";
const MAX_REQUEST_BYTES = 16 * 1024;
// The page sends a dragged slider at most every 100 ms; anything faster is not a person.
const MIN_CHANGE_MS = 40;

interface PendingRequest {
    id: string;
    playerId: number;
    type: RequestKind;
    payload: HmpUiAlert | HmpUiInputDialog | HmpUiContextMenu | HmpUiProgress;
    resolve(value: unknown): void;
    reject(error: unknown): void;
    timer: ReturnType<typeof setTimeout>;
    onChange?: (name: string, value: HmpUiInputValue) => void;
    changedAt?: Map<string, number>;
}

interface Logger {
    warn(...args: unknown[]): unknown;
    error(...args: unknown[]): unknown;
}

function parse(raw: unknown): Record<string, unknown> {
    if (typeof raw === "string") {
        try { return JSON.parse(raw) as Record<string, unknown>; }
        catch (_) { return {}; }
    }
    return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
}

function inputResult(dialog: HmpUiInputDialog, raw: unknown): HmpUiInputResult {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("invalid input response");
    const value = raw as Record<string, unknown>;
    const result: HmpUiInputResult = {};
    for (const field of dialog.fields) result[field.name] = fieldValue(field, value[field.name]);
    return result;
}

function validateResult(pending: PendingRequest, raw: unknown): unknown {
    if (raw === null || raw === undefined) return pending.type === "progress" ? false : null;
    if (pending.type === "alert") {
        if (raw !== "confirm" && raw !== "cancel") throw new TypeError("invalid alert response");
        return raw;
    }
    if (pending.type === "progress") {
        if (typeof raw !== "boolean") throw new TypeError("invalid progress response");
        return raw;
    }
    if (pending.type === "context") {
        if (typeof raw !== "string") throw new TypeError("invalid context response");
        const menu = pending.payload as HmpUiContextMenu;
        const option = menu.options.find((entry) => entry.id === raw);
        if (!option || option.disabled) throw new TypeError("context option was not offered");
        return option.id;
    }
    return inputResult(pending.payload as HmpUiInputDialog, raw);
}

function createUiService<P extends HmpUiPlayer>(options: { logger: Logger; now?: () => number }): HmpUiServer<P> & {
    onResponse(player: P, raw: unknown): boolean;
    onChange(player: P, raw: unknown): boolean;
    disconnect(player?: P | null): number;
    stop(): number;
} {
    const { logger } = options;
    const now = options.now || Date.now;
    const startedAt = now();
    const pending = new Map<string, PendingRequest>();
    const byPlayer = new Map<number, Set<string>>();
    let sequence = 0;

    function playerId(player: P): number {
        const id = Number(player?.id);
        if (!Number.isSafeInteger(id) || id < 0 || typeof player?.emit !== "function") throw new TypeError("a connected player is required");
        return id;
    }

    function track(request: PendingRequest): void {
        pending.set(request.id, request);
        const ids = byPlayer.get(request.playerId) || new Set<string>();
        ids.add(request.id);
        byPlayer.set(request.playerId, ids);
    }

    function forget(request: PendingRequest): void {
        clearTimeout(request.timer);
        pending.delete(request.id);
        const ids = byPlayer.get(request.playerId);
        ids?.delete(request.id);
        if (!ids?.size) byPlayer.delete(request.playerId);
    }

    function request<T>(player: P, type: RequestKind, payload: PendingRequest["payload"], onChange?: PendingRequest["onChange"]): Promise<T> {
        const owner = playerId(player);
        const id = `hmpui:${owner}:${now().toString(36)}:${(++sequence).toString(36)}`;
        const timeoutMs = Number(payload.timeoutMs) || 300000;
        const envelope = JSON.stringify({ id, type, payload });
        if (Buffer.byteLength(envelope, "utf8") > MAX_REQUEST_BYTES) {
            throw new RangeError(`hmp-ui ${type} request exceeds the ${MAX_REQUEST_BYTES}-byte safe event payload`);
        }
        return new Promise<T>((resolve, reject) => {
            const record: PendingRequest = {
                id,
                playerId: owner,
                type,
                payload,
                resolve,
                reject,
                timer: setTimeout(() => {
                    forget(record);
                    resolve((type === "progress" ? false : null) as T);
                }, timeoutMs),
            };
            if (onChange) {
                record.onChange = onChange;
                record.changedAt = new Map();
            }
            record.timer.unref?.();
            track(record);
            try { player.emit("hmp-ui:request", envelope); }
            catch (error) { forget(record); reject(error); }
        });
    }

    function notify(player: P, raw: string | HmpUiNotification): boolean {
        playerId(player);
        player.emit("hmp-ui:notify", JSON.stringify(normalizeNotification(raw)));
        return true;
    }

    function alert(player: P, raw: HmpUiAlert): Promise<"confirm" | "cancel" | null> {
        return request(player, "alert", normalizeAlert(raw));
    }

    function input(player: P, raw: HmpUiInputDialog, options?: HmpUiInputOptions): Promise<HmpUiInputResult | null> {
        const onChange = typeof options?.onChange === "function" ? options.onChange : undefined;
        return request(player, "input", normalizeInput({ ...raw, live: !!onChange }), onChange);
    }

    function context(player: P, raw: HmpUiContextMenu): Promise<string | null> {
        return request(player, "context", normalizeContext(raw));
    }

    function progress(player: P, raw: HmpUiProgress): Promise<boolean> {
        return request(player, "progress", normalizeProgress(raw));
    }

    function onResponse(player: P, raw: unknown): boolean {
        const owner = playerId(player);
        const response = parse(raw);
        const id = String(response.id || "");
        const record = pending.get(id);
        if (!record || record.playerId !== owner) return false;
        forget(record);
        try { record.resolve(validateResult(record, response.result)); }
        catch (error) {
            logger.warn(`[hmp-ui] rejected invalid ${record.type} response from #${owner}:`, error);
            record.reject(error);
        }
        return true;
    }

    // A live edit is only ever advisory: the dialog stays open and the submitted result is still revalidated.
    function onChange(player: P, raw: unknown): boolean {
        const owner = playerId(player);
        const change = parse(raw);
        const record = pending.get(String(change.id || ""));
        if (!record || record.playerId !== owner || record.type !== "input" || !record.onChange || !record.changedAt) return false;
        const field = (record.payload as HmpUiInputDialog).fields.find((entry) => entry.name === change.name);
        if (!field || !liveField(field)) return false;
        const at = now();
        const previous = record.changedAt.get(field.name);
        if (previous !== undefined && at - previous < MIN_CHANGE_MS) return false;
        let value: HmpUiInputValue;
        try { value = fieldValue(field, change.value); }
        catch (error) {
            logger.warn(`[hmp-ui] rejected invalid input change from #${owner}:`, error);
            return false;
        }
        record.changedAt.set(field.name, at);
        try { record.onChange(field.name, value); }
        catch (error) { logger.warn(`[hmp-ui] input change handler for '${field.name}' failed:`, error); }
        return true;
    }

    function settlePlayer(player: P, emitClose: boolean, reason: string): number {
        const owner = playerId(player);
        const ids = [...(byPlayer.get(owner) || [])];
        for (const id of ids) {
            const record = pending.get(id);
            if (!record) continue;
            forget(record);
            record.resolve(record.type === "progress" ? false : null);
        }
        if (emitClose) player.emit("hmp-ui:close", JSON.stringify({ reason: clean(reason, 120) }));
        return ids.length;
    }

    function close(player: P, reason = "closed"): boolean {
        settlePlayer(player, true, reason);
        return true;
    }

    function disconnect(player?: P | null): number {
        if (!player) return 0;
        try { return settlePlayer(player, false, "disconnected"); }
        catch (error) { logger.error("[hmp-ui] disconnect cleanup failed", error); return 0; }
    }

    function stop(): number {
        const records = [...pending.values()];
        for (const record of records) {
            forget(record);
            record.resolve(record.type === "progress" ? false : null);
        }
        return records.length;
    }

    return Object.freeze({
        notify,
        alert,
        input,
        context,
        progress,
        close,
        status: () => ({ pending: pending.size, players: byPlayer.size, uptimeMs: now() - startedAt }),
        onResponse,
        onChange,
        disconnect,
        stop,
    });
}

export = { createUiService, inputResult };
