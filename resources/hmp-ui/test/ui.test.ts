import assert = require("node:assert");
import { test } from "node:test";
import normalizeModule = require("../shared/normalize");
import serverModule = require("../server/ui");
import clientModule = require("../client/ui");
import type { HmpUiPlayer } from "../types";

const { normalizeNotification, normalizeInput, normalizeContext, normalizeProgress } = normalizeModule;
const { createUiService } = serverModule;
const { createUiClient } = clientModule;

const parse = (value: unknown): Record<string, unknown> => JSON.parse(String(value)) as Record<string, unknown>;
const logger = { warn: () => true, error: () => true };

test("normalizes bounded plain-text UI contracts", () => {
    assert.deepStrictEqual(normalizeNotification("Welcome"), { title: undefined, description: "Welcome", tone: "inform", duration: 4500 });
    assert.throws(() => normalizeInput({ title: "Bad", fields: [{ name: "same", label: "One" }, { name: "same", label: "Two" }] }), /duplicate/);
    assert.strictEqual(normalizeInput({ title: "Secret", fields: [{ name: "secret", label: "Secret", type: "password" }] }).fields[0].type, "password");
    const catalog = normalizeInput({
        title: "Catalog",
        fields: [{
            name: "item", label: "Item", type: "select", searchable: true,
            options: Array.from({ length: 200 }, (_, index) => ({ label: `Item ${index}`, value: `item:${index}`, description: `Catalog row ${index}` })),
        }],
    }).fields[0];
    assert.strictEqual(catalog.searchable, true);
    assert.strictEqual(catalog.options?.length, 192);
    assert.strictEqual(catalog.options?.[191].description, "Catalog row 191");
    assert.throws(() => normalizeContext({ title: "Bad", options: [{ id: "spaces are invalid", title: "No" }] }), /invalid/);
    const icons = normalizeContext({ title: "Icons", options: [{ id: "safe", title: "Safe", icon: "fw://resources/items/icon.svg" }, { id: "unsafe", title: "Unsafe", icon: "javascript:alert(1)" }] });
    assert.strictEqual(icons.options[0].icon, "fw://resources/items/icon.svg");
    assert.strictEqual(icons.options[1].icon, undefined);
    assert.strictEqual(normalizeProgress({ label: "Casting", duration: 999999 }).duration, 600000);
});

test("server correlates responses and revalidates client selections", async () => {
    const sent: Array<{ name: string; payload: unknown }> = [];
    const player: HmpUiPlayer = { id: 7, emit: (name, payload) => sent.push({ name, payload }) };
    const ui = createUiService<HmpUiPlayer>({ logger, now: () => 100 });

    const alert = ui.alert(player, { title: "Leave?", content: "Unsaved work", cancel: true });
    const alertRequest = parse(sent.at(-1)?.payload);
    assert.strictEqual(alertRequest.type, "alert");
    assert.strictEqual(ui.onResponse(player, JSON.stringify({ id: alertRequest.id, result: "confirm" })), true);
    assert.strictEqual(await alert, "confirm");

    const context = ui.context(player, { title: "Actions", options: [{ id: "inspect", title: "Inspect" }, { id: "locked", title: "Locked", disabled: true }] });
    const contextRequest = parse(sent.at(-1)?.payload);
    assert.strictEqual(ui.onResponse(player, { id: contextRequest.id, result: "locked" }), true);
    await assert.rejects(context, /not offered/);

    const input = ui.input(player, { title: "Amount", fields: [{ name: "amount", label: "Amount", type: "number", min: 1, max: 5 }] });
    const inputRequest = parse(sent.at(-1)?.payload);
    ui.onResponse(player, { id: inputRequest.id, result: { amount: "3", ignored: "no" } });
    assert.deepStrictEqual(await input, { amount: 3 });
    assert.strictEqual(ui.status().pending, 0);

    const oversized = Array.from({ length: 16 }, (_, field) => ({
        name: `field_${field}`, label: `Field ${field}`, type: "select" as const,
        options: Array.from({ length: 32 }, (_, option) => ({
            label: `Option ${option} ${"L".repeat(70)}`,
            value: `value:${field}:${option}:${"V".repeat(90)}`,
            description: "D".repeat(180),
        })),
    }));
    assert.throws(() => ui.input(player, { title: "Too large", fields: oversized }), /safe event payload/);
    assert.strictEqual(ui.status().pending, 0);
});

test("server notifications are fire-and-forget and disconnect settles pending work", async () => {
    const sent: Array<{ name: string; payload: unknown }> = [];
    const player: HmpUiPlayer = { id: 9, emit: (name, payload) => sent.push({ name, payload }) };
    const ui = createUiService<HmpUiPlayer>({ logger });
    assert.strictEqual(ui.notify(player, { description: "Done", tone: "success" }), true);
    assert.strictEqual(sent[0].name, "hmp-ui:notify");
    const progress = ui.progress(player, { label: "Working", duration: 1000 });
    assert.strictEqual(ui.disconnect(player), 1);
    assert.strictEqual(await progress, false);
});

test("client queues until the page is ready and balances focus on completion", async () => {
    const handlers = new Map<string, (payload?: unknown) => unknown>();
    const pageEvents: Array<{ name: string; payload: unknown }> = [];
    const serverEvents: Array<{ name: string; payload: unknown }> = [];
    let shown = 0;
    let hidden = 0;
    let focused = 0;
    let leases = 0;
    let releases = 0;
    const web = {
        createView: () => 4,
        destroyView: () => true,
        showView: () => { shown++; return true; },
        hideView: () => { hidden++; return true; },
        focusView: () => { focused++; return true; },
        emit: (_view: number, name: string, payload?: unknown) => { pageEvents.push({ name, payload }); return true; },
        on: (_view: number, name: string, listener: (payload?: unknown) => unknown) => handlers.set(name, listener),
    };
    const ui = createUiClient({
        web,
        events: { emitServer: (name, payload) => serverEvents.push({ name, payload }) },
        input: { controls: { acquire() { leases++; return { release() { releases++; return true; } }; } } },
        transitionGraceMs: 0,
    });
    const answer = ui.alert({ title: "Question" });
    assert.strictEqual(pageEvents.length, 0);
    handlers.get("ready")?.();
    const request = pageEvents.find((event) => event.name === "request")?.payload as { id: string };
    assert.ok(request.id);
    assert.strictEqual(focused, 1);
    assert.strictEqual(leases, 1);
    handlers.get("response")?.({ id: request.id, result: "confirm" });
    assert.strictEqual(await answer, "confirm");
    assert.ok(shown >= 1);
    assert.strictEqual(hidden, 1);
    assert.strictEqual(releases, 1);

    assert.strictEqual(ui.receiveRequest(JSON.stringify({ id: "remote:1", type: "context", payload: { title: "Pick", options: [{ id: "yes", title: "Yes" }] } })), true);
    const remote = pageEvents.filter((event) => event.name === "request").at(-1)?.payload as { id: string };
    handlers.get("response")?.({ id: remote.id, result: "yes" });
    assert.deepStrictEqual(parse(serverEvents.at(-1)?.payload), { id: "remote:1", result: "yes" });

    const first = ui.alert({ title: "First" });
    const second = ui.alert({ title: "Second" });
    assert.strictEqual(ui.close(), true);
    assert.strictEqual(await first, "cancel");
    assert.strictEqual(await second, "cancel");
    assert.strictEqual(ui.status().queued, 0);
    assert.strictEqual(ui.status().active, null);
});

test("client bridges chained server menus without dropping the backdrop or focus", () => {
    const handlers = new Map<string, (payload?: unknown) => unknown>();
    const pageEvents: Array<{ name: string; payload: unknown }> = [];
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    let hidden = 0;
    let focused = 0;
    let leases = 0;
    let releases = 0;
    const setTimer = ((callback: () => void) => {
        const id = ++nextTimer;
        timers.set(id, callback);
        return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const clearTimer = ((timer: ReturnType<typeof setTimeout>) => {
        timers.delete(timer as unknown as number);
    }) as typeof clearTimeout;
    const web = {
        createView: () => 8,
        destroyView: () => true,
        showView: () => true,
        hideView: () => { hidden++; return true; },
        focusView: () => { focused++; return true; },
        emit: (_view: number, name: string, payload?: unknown) => { pageEvents.push({ name, payload }); return true; },
        on: (_view: number, name: string, listener: (payload?: unknown) => unknown) => handlers.set(name, listener),
    };
    const ui = createUiClient({
        web,
        events: { emitServer: () => true },
        input: { controls: { acquire() { leases++; return { release() { releases++; return true; } }; } } },
        transitionGraceMs: 160,
        setTimer,
        clearTimer,
    });

    ui.receiveRequest({ id: "remote:one", type: "context", payload: { title: "First", options: [{ id: "next", title: "Next" }] } });
    handlers.get("ready")?.();
    handlers.get("response")?.({ id: "remote:one", result: "next" });
    assert.strictEqual(hidden, 0);
    assert.strictEqual(releases, 0);
    assert.strictEqual(timers.size, 1);

    ui.receiveRequest({ id: "remote:two", type: "context", payload: { title: "Second", options: [{ id: "done", title: "Done" }] } });
    assert.strictEqual(timers.size, 0);
    assert.strictEqual(focused, 1);
    assert.strictEqual(leases, 1);
    assert.strictEqual(pageEvents.filter((event) => event.name === "clear").length, 0);

    handlers.get("response")?.({ id: "remote:two", result: "done" });
    assert.strictEqual(timers.size, 1);
    const release = [...timers.values()][0];
    timers.clear();
    release();
    assert.strictEqual(hidden, 1);
    assert.strictEqual(releases, 1);
    assert.strictEqual(pageEvents.filter((event) => event.name === "clear").length, 1);
});

test("client notifications remain unfocused and hide after the page reports idle", () => {
    const handlers = new Map<string, (payload?: unknown) => unknown>();
    let focused = 0;
    let hidden = 0;
    const web = {
        createView: () => 2,
        destroyView: () => true,
        showView: () => true,
        hideView: () => { hidden++; return true; },
        focusView: () => { focused++; return true; },
        emit: () => true,
        on: (_view: number, name: string, listener: (payload?: unknown) => unknown) => handlers.set(name, listener),
    };
    const ui = createUiClient({ web, events: { emitServer: () => true } });
    ui.notify("Hello");
    handlers.get("ready")?.();
    assert.strictEqual(focused, 0);
    handlers.get("idle")?.();
    assert.strictEqual(hidden, 1);
});
