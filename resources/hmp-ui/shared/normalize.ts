import type {
    HmpUiAlert,
    HmpUiContextMenu,
    HmpUiContextMetadata,
    HmpUiContextOption,
    HmpUiInputDialog,
    HmpUiInputField,
    HmpUiNotification,
    HmpUiProgress,
    HmpUiSelectOption,
    HmpUiTone,
} from "../types";

const FIELD_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const OPTION_ID = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;
const tones = new Set<HmpUiTone>(["inform", "success", "warning", "error"]);

function clean(value: unknown, max: number): string {
    return String(value ?? "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ").replace(/\r\n?/g, "\n").trim().slice(0, max);
}

function finite(value: unknown, fallback: number, min: number, max: number): number {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function tone(value: unknown): HmpUiTone {
    return tones.has(value as HmpUiTone) ? value as HmpUiTone : "inform";
}

function normalizeNotification(raw: string | HmpUiNotification): HmpUiNotification {
    const value = typeof raw === "string" ? { description: raw } : raw || { description: "" };
    const description = clean(value.description, 320);
    if (!description) throw new TypeError("notification description is required");
    return {
        title: clean(value.title, 64) || undefined,
        description,
        tone: tone(value.tone),
        duration: Math.trunc(finite(value.duration, 4500, 500, 30000)),
    };
}

function normalizeAlert(raw: HmpUiAlert): HmpUiAlert {
    if (!raw || typeof raw !== "object") throw new TypeError("alert dialog is required");
    const title = clean(raw.title, 80);
    if (!title) throw new TypeError("alert title is required");
    return {
        title,
        content: clean(raw.content, 2000),
        confirmLabel: clean(raw.confirmLabel, 32) || "Confirm",
        cancelLabel: clean(raw.cancelLabel, 32) || "Cancel",
        cancel: raw.cancel !== false,
        timeoutMs: Math.trunc(finite(raw.timeoutMs, 300000, 5000, 900000)),
    };
}

function normalizeSelectOptions(raw: unknown, limit = 192): HmpUiSelectOption[] {
    const options: HmpUiSelectOption[] = [];
    for (const entry of Array.isArray(raw) ? raw.slice(0, limit) : []) {
        if (!entry || typeof entry !== "object") continue;
        const value = entry as Record<string, unknown>;
        const label = clean(value.label, 80);
        const optionValue = clean(value.value, 128);
        if (label && optionValue) options.push({ label, value: optionValue, description: clean(value.description, 180) || undefined });
    }
    return options;
}

function normalizeInput(raw: HmpUiInputDialog): HmpUiInputDialog {
    if (!raw || typeof raw !== "object") throw new TypeError("input dialog is required");
    const title = clean(raw.title, 80);
    if (!title) throw new TypeError("input title is required");
    if (!Array.isArray(raw.fields) || !raw.fields.length) throw new TypeError("input fields are required");
    const fields: HmpUiInputField[] = [];
    const names = new Set<string>();
    for (const entry of raw.fields.slice(0, 16)) {
        if (!entry || typeof entry !== "object") continue;
        const name = clean(entry.name, 32).toLowerCase();
        if (!FIELD_NAME.test(name) || names.has(name)) throw new TypeError(`invalid or duplicate input field '${name}'`);
        names.add(name);
        const fieldType = ["text", "password", "textarea", "number", "checkbox", "select"].includes(String(entry.type)) ? entry.type : "text";
        const field: HmpUiInputField = {
            name,
            label: clean(entry.label, 80) || name,
            type: fieldType,
            description: clean(entry.description, 180) || undefined,
            placeholder: clean(entry.placeholder, 120) || undefined,
            required: entry.required === true,
        };
        if (fieldType === "checkbox") field.default = entry.default === true;
        else if (fieldType === "number") {
            if (entry.default !== undefined && Number.isFinite(Number(entry.default))) field.default = Number(entry.default);
            if (entry.min !== undefined && Number.isFinite(Number(entry.min))) field.min = Number(entry.min);
            if (entry.max !== undefined && Number.isFinite(Number(entry.max))) field.max = Number(entry.max);
        } else if (entry.default !== undefined) field.default = clean(entry.default, 1000);
        if (fieldType === "select") {
            field.searchable = entry.searchable === true;
            field.options = normalizeSelectOptions(entry.options);
            if (!field.options.length) throw new TypeError(`select field '${name}' requires options`);
        }
        fields.push(field);
    }
    if (!fields.length) throw new TypeError("input fields are required");
    return {
        title,
        fields,
        submitLabel: clean(raw.submitLabel, 32) || "Submit",
        cancelLabel: clean(raw.cancelLabel, 32) || "Cancel",
        allowCancel: raw.allowCancel !== false,
        timeoutMs: Math.trunc(finite(raw.timeoutMs, 300000, 5000, 900000)),
    };
}

function normalizeMetadata(raw: unknown): HmpUiContextMetadata[] {
    const result: HmpUiContextMetadata[] = [];
    for (const entry of Array.isArray(raw) ? raw.slice(0, 12) : []) {
        if (!entry || typeof entry !== "object") continue;
        const value = entry as Record<string, unknown>;
        const label = clean(value.label, 48);
        const text = clean(value.value, 96);
        if (label && text) result.push({ label, value: text });
    }
    return result;
}

function iconUrl(value: unknown): string | undefined {
    const url = clean(value, 400);
    return /^(?:https?|fw):\/\//i.test(url) ? url : undefined;
}

function normalizeContext(raw: HmpUiContextMenu): HmpUiContextMenu {
    if (!raw || typeof raw !== "object") throw new TypeError("context menu is required");
    const title = clean(raw.title, 80);
    if (!title) throw new TypeError("context title is required");
    if (!Array.isArray(raw.options) || !raw.options.length) throw new TypeError("context options are required");
    const ids = new Set<string>();
    const options: HmpUiContextOption[] = [];
    for (const entry of raw.options.slice(0, 32)) {
        if (!entry || typeof entry !== "object") continue;
        const id = clean(entry.id, 64);
        if (!OPTION_ID.test(id) || ids.has(id)) throw new TypeError(`invalid or duplicate context option '${id}'`);
        ids.add(id);
        options.push({
            id,
            title: clean(entry.title, 80) || id,
            icon: iconUrl(entry.icon),
            description: clean(entry.description, 180) || undefined,
            disabled: entry.disabled === true,
            tone: tone(entry.tone),
            metadata: normalizeMetadata(entry.metadata),
        });
    }
    if (!options.length) throw new TypeError("context options are required");
    return {
        title,
        description: clean(raw.description, 320) || undefined,
        options,
        cancelLabel: clean(raw.cancelLabel, 32) || "Close",
        canClose: raw.canClose !== false,
        timeoutMs: Math.trunc(finite(raw.timeoutMs, 300000, 5000, 900000)),
    };
}

function normalizeProgress(raw: HmpUiProgress): HmpUiProgress {
    if (!raw || typeof raw !== "object") throw new TypeError("progress definition is required");
    const label = clean(raw.label, 120);
    if (!label) throw new TypeError("progress label is required");
    const duration = Math.trunc(finite(raw.duration, 0, 100, 600000));
    if (!duration) throw new TypeError("progress duration must be at least 100ms");
    return {
        label,
        duration,
        canCancel: raw.canCancel === true,
        cancelLabel: clean(raw.cancelLabel, 32) || "Cancel",
        timeoutMs: Math.trunc(finite(raw.timeoutMs, duration + 30000, duration + 1000, 900000)),
    };
}

export = { clean, normalizeNotification, normalizeAlert, normalizeInput, normalizeContext, normalizeProgress };
