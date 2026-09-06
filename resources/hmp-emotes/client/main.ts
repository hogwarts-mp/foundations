import type { HmpControlLease, HmpLibClient } from "../../hmp-lib/types";
import type { HmpEmoteChannel, HmpEmoteKind } from "../types";

interface EmoteRow {
    path: string;
    alias?: string;
    kind: HmpEmoteKind;
    channel: HmpEmoteChannel;
    loop?: boolean;
    hold?: boolean;
}

interface PreviewOptions {
    show?: boolean;
    mode?: "screen" | "world";
    nudge?: number;
    commit?: boolean;
    release?: boolean;
    anchor?: boolean;
    clip?: string;
    loop?: boolean;
    dump?: boolean;
    tune?: Record<string, number>;
    world?: Record<string, unknown>;
}

interface PreviewState {
    ok: boolean;
    visible: boolean;
    ready: boolean;
    placeable: boolean;
    committed: boolean;
    anchored: boolean;
    status: string;
}

declare const LocalPlayer: {
    stopEmote(): boolean;
    photoPose(path?: string): boolean;
    playClip(path?: string, options?: { loop?: boolean; hold?: boolean; rate?: number }): boolean;
    playAbility(path: string, channel?: string): boolean;
    cancelAbility(channel?: string): boolean;
    stopPlayerInput(): boolean | null;
    restorePlayerInput(): boolean | null;
    emotePreview(options?: PreviewOptions): PreviewState;
};

const DEFAULT_VIEW_URL = "fw://resources/hmp-emotes/dist/menu.html";
const UI_CONTRACT = "hmp.emotes.ui/v1";
const Input = Imports.get<HmpLibClient>("hmp-lib").input;
let view = -1;
let viewUrl = DEFAULT_VIEW_URL;
let pageReady = false;
let visible = false;
let previewOn = true;
let controls: HmpControlLease | null = null;
let placing: EmoteRow | null = null;
let stopped = false;

function parse(raw: unknown): Record<string, unknown> {
    if (typeof raw === "string") { try { return JSON.parse(raw) as Record<string, unknown>; } catch (_) { return {}; } }
    return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
}

function rowOf(raw: unknown): EmoteRow | null {
    const value = parse(raw);
    const path = String(value.path || "").trim();
    if (!path) return null;
    return {
        path,
        alias: String(value.alias || ""),
        kind: value.kind === "ability" ? "ability" : "pose",
        channel: value.channel === "PartialBody" ? "PartialBody" : "FullBody",
        loop: value.loop !== false,
        hold: value.hold !== false,
    };
}

function server(name: string, payload: unknown = {}): void {
    try { Events.emitServer(name, JSON.stringify(payload)); }
    catch (_) {}
}

function reply(text: string): void {
    server("hmp-emotes:result", { text });
}

function preview(options: PreviewOptions): PreviewState | null {
    try {
        const result = LocalPlayer.emotePreview(options);
        if (result?.status) reply(result.status);
        return result;
    } catch (error) {
        console.warn(`[hmp-emotes] preview failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

function stopEmote(): void {
    preview({ anchor: false });
    LocalPlayer.stopEmote();
}

function stopEverything(): void {
    stopEmote();
    try { LocalPlayer.cancelAbility("FullBody"); } catch (_) {}
    try { LocalPlayer.cancelAbility("PartialBody"); } catch (_) {}
    try { LocalPlayer.photoPose(""); } catch (_) {}
}

function play(row: EmoteRow): boolean {
    if (row.kind === "ability") return LocalPlayer.playAbility(row.path, row.channel);
    return LocalPlayer.playClip(row.path, { loop: row.loop !== false, hold: row.hold !== false });
}

function lockControls(enable: boolean): void {
    if (enable && !controls) controls = Input.controls.acquire({ resource: "hmp-emotes", id: "menu" });
    else if (!enable && controls) { controls.release(); controls = null; }
}

function wire(): void {
    Web.on(view, "ready", () => {
        pageReady = true;
        Web.emit(view, "configure", { contract: UI_CONTRACT });
        server("hmp-emotes:favorites-request");
        server("hmp-emotes:aliases-request");
        if (visible) Web.emit(view, "em:focus", {});
    });
    Web.on(view, "play", (raw: unknown) => {
        const row = rowOf(raw);
        if (!row) return;
        if (!play(row)) reply(row.kind === "ability" ? `ability failed (${row.channel}): ${row.path}` : `posed but not animating: ${row.path}`);
    });
    Web.on(view, "stop", stopEmote);
    Web.on(view, "preview", (raw: unknown) => {
        const row = rowOf(raw);
        if (previewOn) preview({ clip: row?.kind === "pose" ? row.path : "", loop: true });
    });
    Web.on(view, "previewTune", (raw: unknown) => {
        const value = parse(raw);
        if (value.tune && typeof value.tune === "object") preview({ tune: value.tune as Record<string, number> });
        if (value.world && typeof value.world === "object") preview({ world: value.world as Record<string, unknown> });
    });
    Web.on(view, "previewDump", () => {
        const result = preview({ dump: true });
        Web.emit(view, "em:dump", { text: result?.status || "(no answer)" });
    });
    Web.on(view, "previewToggle", (raw: unknown) => {
        previewOn = parse(raw).on === true;
        preview({ show: previewOn && visible });
    });
    Web.on(view, "place", (raw: unknown) => { const row = rowOf(raw); if (row) placeStart(row); });
    Web.on(view, "favToggle", (raw: unknown) => { const path = String(parse(raw).path || ""); if (path) server("hmp-emotes:favorite-toggle", { path }); });
    Web.on(view, "allowToggle", (raw: unknown) => {
        const row = rowOf(raw);
        if (!row) return;
        server("hmp-emotes:allow-toggle", { ...row, allowed: parse(raw).allowed === true });
    });
    Web.on(view, "aliasSet", (raw: unknown) => {
        const row = rowOf(raw);
        if (!row) return;
        server("hmp-emotes:alias-set", { ...row, alias: String(parse(raw).alias || "").trim().toLowerCase() });
    });
    Web.on(view, "close", () => hideMenu());
}

function destroyView(): void {
    if (view >= 0) { try { Web.destroyView(view); } catch (_) {} }
    view = -1;
    pageReady = false;
}

function ensureView(): number {
    if (view >= 0) return view;
    try { view = Web.createView(viewUrl, { visible: false }); if (view >= 0) wire(); }
    catch (_) { view = -1; }
    return view;
}

function configure(raw: unknown): void {
    const value = parse(raw);
    if (value.contract !== UI_CONTRACT) return;
    const next = String(value.url || "").trim();
    if (!next || (next !== DEFAULT_VIEW_URL && !next.startsWith("fw://resources/") && !next.startsWith("https://")) || next === viewUrl) return;
    const reopen = visible;
    hideMenu();
    destroyView();
    viewUrl = next;
    if (reopen) showMenu();
}

function showMenu(): void {
    if (visible || stopped) return;
    if (ensureView() < 0) { Game.notify("[emotes] The emote menu is unavailable."); return; }
    visible = true;
    Web.showView(view);
    Web.focusView(view);
    lockControls(true);
    if (previewOn) preview({ show: true });
    if (pageReady) Web.emit(view, "em:focus", {});
}

function hideMenu(keepFigure = false): void {
    if (visible) server("hmp-emotes:menu-closed");
    visible = false;
    if (view >= 0) Web.hideView(view);
    if (!keepFigure) preview({ show: false });
    lockControls(false);
}

function releaseInputWhenKeysUp(waitedMs = 0): void {
    const keys = ["q", "e", "mouse1", "enter", "escape"];
    if (keys.some((key) => Input.shortcuts.isDown(key)) && waitedMs < 3000) {
        setTimeout(() => releaseInputWhenKeysUp(waitedMs + 40), 40);
        return;
    }
    LocalPlayer.restorePlayerInput();
}

function placeStop(commit: boolean): void {
    if (!placing) return;
    const row = placing;
    placing = null;
    const state = commit ? preview({ commit: true }) : null;
    preview({ mode: "screen", show: false });
    releaseInputWhenKeysUp();
    if (commit && state?.committed) {
        play({ ...row, loop: true, hold: true });
        Game.notify("[emotes] Use /e stop to get up.");
    } else if (commit) Game.notify("[emotes] Couldn't place you there.");
}

function placeStart(row: EmoteRow): void {
    if (placing || stopped) return;
    placing = row;
    preview({ mode: "world", clip: row.kind === "ability" ? "" : row.path, loop: true, show: true });
    LocalPlayer.stopPlayerInput();
    hideMenu(true);
    Game.notify("[emotes] Q/E turn · click or Enter to place · Esc to cancel");
}

for (const definition of [
    { id: "place-left", key: "q", handler: () => preview({ nudge: -15 }) },
    { id: "place-right", key: "e", handler: () => preview({ nudge: 15 }) },
    { id: "place-click", key: "mouse1", handler: () => placeStop(true) },
    { id: "place-enter", key: "enter", handler: () => placeStop(true) },
    { id: "place-cancel", key: "escape", handler: () => placeStop(false) },
]) Input.shortcuts.register({ resource: "hmp-emotes", id: definition.id, key: definition.key, state: "down", priority: 1000, when: () => placing !== null, handler: definition.handler });

Events.on("hmp-emotes:configure", configure);
Events.on("hmp-emotes:open", showMenu);
Events.on("hmp-emotes:close", hideMenu);
Events.on("hmp-emotes:stop", stopEmote);
Events.on("hmp-emotes:play", (raw: unknown) => { const row = rowOf(raw); if (row) play(row); });
Events.on("hmp-emotes:favorites", (raw: unknown) => { if (view >= 0) Web.emit(view, "em:favs", { paths: parse(raw).paths || [] }); });
Events.on("hmp-emotes:aliases", (raw: unknown) => {
    const value = parse(raw);
    if (view >= 0) Web.emit(view, "em:aliases", {
        aliases: value.aliases || {},
        ...(typeof value.canEdit === "boolean" ? { canEdit: value.canEdit } : {}),
        ...(typeof value.allowAll === "boolean" ? { allowAll: value.allowAll } : {}),
        ...(typeof value.browseUnaliased === "boolean" ? { browseUnaliased: value.browseUnaliased } : {}),
    });
});
Events.on("hmp-emotes:photo-pose", (raw: unknown) => {
    const path = String(parse(raw).path || "");
    reply(LocalPlayer.photoPose(path) ? path ? `pose ok: ${path}` : "pose cleared" : `pose failed: ${path}`);
});
Events.on("hmp-emotes:play-ability", (raw: unknown) => {
    const value = parse(raw);
    const path = String(value.path || "");
    const channel = value.channel === "PartialBody" ? "PartialBody" : "FullBody";
    reply(path && LocalPlayer.playAbility(path, channel) ? `ability ok (${channel}): ${path}` : `ability failed (${channel}): ${path}`);
});
Events.on("resourceStop", (name?: string) => {
    if (name && name !== "hmp-emotes") return;
    stopped = true;
    if (placing) placeStop(false);
    hideMenu();
    stopEverything();
    preview({ release: true });
    destroyView();
    Input.cleanup("hmp-emotes");
});

// Recover a pawn stranded by a prior disconnect during placement. Resource startup can precede pawn
// creation, so retry briefly instead of treating the first null-pawn response as authoritative.
let releaseAttempts = 0;
function releaseStranded(): void {
    const result = preview({ release: true });
    if (!result?.ok && ++releaseAttempts < 30) setTimeout(releaseStranded, 1000);
}
releaseStranded();
server("hmp-emotes:ready");
console.info("[hmp-emotes] client emote coordinator ready");
