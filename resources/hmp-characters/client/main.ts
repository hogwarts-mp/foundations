import type { HmpControlLease, HmpLibClient } from "../../hmp-lib/types";
import type { HmpCharacterCard, HmpCharacterLook, HmpCharacterUiModel } from "../types";

const VIEW_URL = "fw://resources/hmp-characters/dist/index.html";
const READY_TIMEOUT_MS = 8000;
const PORTRAIT_PX = 96;
const PORTRAIT_POLL_MS = 50;
const PORTRAIT_RETRY_MS = 300;
const PORTRAIT_TIMEOUT_MS = 20_000;
const MAX_PORTRAIT_BYTES = 3 * 1024 * 1024;
const PORTRAIT_POSE = "/Game/Animation/Human/PhotoMode/Hu_PhotoMode_Stand3_01_pose_anm.Hu_PhotoMode_Stand3_01_pose_anm";
const Input = Imports.get<HmpLibClient>("hmp-lib").input;

interface ClientCharacter extends HmpCharacterCard {
    appearance?: string;
    transmog?: string;
    portrait?: string;
    portraitQueuedAt?: number;
}

type ClientModel = Omit<HmpCharacterUiModel, "characters"> & { characters: ClientCharacter[] };

let view = -1;
let pageReady = false;
let visible = false;
let controlLease: HmpControlLease | null = null;
let model: ClientModel | null = null;
let readyTimer: ReturnType<typeof setTimeout> | null = null;
let creationRequested = false;

const portraits = new Map<string, string>();
const portraitQueue: ClientCharacter[] = [];
const pendingLooks: HmpCharacterLook[] = [];
let portraitInFlight: ClientCharacter | null = null;

function lockControls(locked: boolean): void {
    if (locked && !controlLease) controlLease = Input.controls.acquire({ resource: "hmp-characters", id: "screen" });
    else if (!locked && controlLease) { controlLease.release(); controlLease = null; }
}

function ensureView(): number {
    if (view >= 0) return view;
    try { view = Web.createView(VIEW_URL, { visible: false }); }
    catch (_) { view = -1; }
    if (view >= 0) wire();
    return view;
}

function browserModel(): HmpCharacterUiModel | null {
    if (!model) return null;
    return {
        ...model,
        characters: model.characters.map(({ id, slot, name }) => ({ id, slot, name })),
    };
}

function push(): void {
    if (view < 0 || !pageReady || !model) return;
    Web.emit(view, "hmp-characters:model", browserModel());
    for (const character of model.characters) {
        if (character.portrait !== undefined) {
            Web.emit(view, "hmp-characters:portrait", { characterId: character.id, src: character.portrait });
        }
    }
}

function show(payload?: ClientModel): void {
    if (payload) model = payload;
    if (ensureView() < 0) {
        Game.notify("[characters] The character screen is not ready yet.");
        return;
    }
    visible = true;
    Web.showView(view);
    Web.focusView(view);
    lockControls(true);
    if (pageReady) push();
    else {
        if (readyTimer) clearTimeout(readyTimer);
        readyTimer = setTimeout(() => {
            readyTimer = null;
            if (!pageReady && visible) {
                Game.notify("[characters] The character screen did not open; your controls have been restored.");
                hide(true);
            }
        }, READY_TIMEOUT_MS);
    }
}

function hide(unlock = true): void {
    visible = false;
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
    if (view >= 0) Web.hideView(view);
    if (unlock) lockControls(false);
}

function requestCreate(): void {
    if (creationRequested) return;
    creationRequested = true;
    Events.emitServer("hmp-characters:create", "{}");
}

function openCreator(): void {
    hide(true);
    try { Creator.open(); }
    catch (_) {
        creationRequested = false;
        Events.emitServer("hmp-characters:cancelled", "{}");
        return;
    }
    setTimeout(() => {
        try { if (Creator.isOpen()) return; }
        catch (_) { /* report the failed open below */ }
        creationRequested = false;
        Events.emitServer("hmp-characters:cancelled", "{}");
        Game.notify("[characters] The creator is not ready; please try again.");
    }, 600);
}

function lookKey(character: ClientCharacter): string {
    return `${character.appearance || ""}|${character.transmog || ""}`;
}

function publishPortrait(key: string, src: string): void {
    portraits.set(key, src);
    if (!model) return;
    for (const character of model.characters) {
        if (!character.appearance || lookKey(character) !== key) continue;
        character.portrait = src;
        if (visible && pageReady && view >= 0) {
            Web.emit(view, "hmp-characters:portrait", { characterId: character.id, src });
        }
    }
}

function finishPortrait(key: string, src: string): void {
    publishPortrait(key, src);
    portraitInFlight = null;
    pumpPortraits();
}

function pumpPortraits(): void {
    if (portraitInFlight || !portraitQueue.length) return;
    const character = portraitQueue[0];
    const key = lookKey(character);
    let accepted = false;
    try {
        if (typeof Portrait !== "object" || typeof Portrait.capture !== "function") {
            portraitQueue.shift();
            finishPortrait(key, "");
            return;
        }
        accepted = Portrait.capture({
            ccd: character.appearance,
            transmog: character.transmog || "",
            framing: "face",
            pose: PORTRAIT_POSE,
            size: PORTRAIT_PX,
            matte: false,
            name: "hmp-characters",
        });
    } catch (_) {
        portraitQueue.shift();
        finishPortrait(key, "");
        return;
    }
    if (!accepted) {
        if (Date.now() - Number(character.portraitQueuedAt || 0) > PORTRAIT_TIMEOUT_MS) {
            portraitQueue.shift();
            finishPortrait(key, "");
            return;
        }
        setTimeout(pumpPortraits, PORTRAIT_RETRY_MS);
        return;
    }
    portraitQueue.shift();
    portraitInFlight = character;
    setTimeout(() => pollPortrait(character, Date.now()), PORTRAIT_POLL_MS);
}

function pollPortrait(character: ClientCharacter, startedAt: number): void {
    const key = lookKey(character);
    let result = "";
    try { result = Portrait.result(); }
    catch (_) { result = "FAIL"; }
    if (result) {
        let src = "";
        if (!result.startsWith("FAIL")) {
            try { src = Portrait.lastImage(MAX_PORTRAIT_BYTES); }
            catch (_) { src = ""; }
        }
        finishPortrait(key, src);
        return;
    }
    let busy = false;
    try { busy = Portrait.busy(); }
    catch (_) { busy = false; }
    if (!busy || Date.now() - startedAt > PORTRAIT_TIMEOUT_MS) {
        finishPortrait(key, "");
        return;
    }
    setTimeout(() => pollPortrait(character, startedAt), PORTRAIT_POLL_MS);
}

function enqueuePortrait(character: ClientCharacter): void {
    if (!character.appearance) {
        character.portrait = "";
        if (visible && pageReady && view >= 0) {
            Web.emit(view, "hmp-characters:portrait", { characterId: character.id, src: "" });
        }
        return;
    }
    const key = lookKey(character);
    if (portraits.has(key)) {
        publishPortrait(key, portraits.get(key) || "");
        return;
    }
    if (portraitInFlight && lookKey(portraitInFlight) === key) return;
    if (portraitQueue.some((queued) => lookKey(queued) === key)) return;
    character.portraitQueuedAt = Date.now();
    portraitQueue.push(character);
    pumpPortraits();
}

function applyLook(look: HmpCharacterLook): void {
    const character = model?.characters.find((candidate) => candidate.id === Number(look.characterId));
    if (!character) {
        if (pendingLooks.length < 32) pendingLooks.push(look);
        return;
    }
    character.appearance = String(look.appearance || "");
    character.transmog = String(look.transmog || "");
    enqueuePortrait(character);
}

function normalizeModel(payload: unknown): ClientModel {
    const source = payload && typeof payload === "object" ? payload as Partial<HmpCharacterUiModel> : {};
    return {
        mode: String(source.mode || "wardrobe"),
        title: String(source.title || "Choose Your Wizard"),
        subtitle: String(source.subtitle || "Every story begins with a name."),
        characters: Array.isArray(source.characters) ? source.characters.map((character) => ({
            id: Number(character.id),
            slot: Number(character.slot),
            name: String(character.name || "Character"),
        })) : [],
        activeCharacterId: Number(source.activeCharacterId) || null,
        lastCharacterId: Number(source.lastCharacterId) || null,
        limit: Math.max(1, Number(source.limit) || 1),
        full: source.full === true,
        allowDelete: source.allowDelete === true,
        canClose: source.canClose === true,
    };
}

function wire(): void {
    Web.on(view, "ready", () => {
        pageReady = true;
        if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
        if (visible) push();
    });
    Web.on(view, "select", (payload) => Events.emitServer("hmp-characters:select", JSON.stringify(payload || {})));
    Web.on(view, "create", () => requestCreate());
    Web.on(view, "delete", (payload) => Events.emitServer("hmp-characters:delete", JSON.stringify(payload || {})));
    Web.on(view, "close", () => Events.emitServer("hmp-characters:close", "{}"));
}

Events.on("hmp-characters:open", (payload) => {
    model = normalizeModel(payload);
    creationRequested = false;
    if (model.mode === "create") requestCreate();
    else show();
    const early = pendingLooks.splice(0);
    for (const look of early) applyLook(look);
});
Events.on("hmp-characters:look", (payload) => {
    if (!payload || typeof payload !== "object") return;
    applyLook(payload as HmpCharacterLook);
});
Events.on("hmp-characters:close", () => hide(true));
Events.on("hmp-characters:create", () => openCreator());
Events.on("hmp-characters:error", (payload) => {
    creationRequested = false;
    const message = payload && typeof payload === "object" && "message" in payload ? payload.message : undefined;
    Game.notify(`[characters] ${String(message || "The action could not be completed.")}`);
    if (!visible && model) show();
    if (visible && pageReady) Web.emit(view, "hmp-characters:error", payload || {});
});
Events.on("hmp-characters:saved", (payload) => {
    const character = payload && typeof payload === "object" && "character" in payload && payload.character && typeof payload.character === "object" ? payload.character : null;
    const name = character && "name" in character ? character.name : "Character";
    Game.notify(`[characters] ${name} is ready.`);
});

Events.on("creatorConfirmed", (payload) => {
    if (!creationRequested) return;
    lockControls(true);
    Events.emitServer("hmp-characters:confirmed", JSON.stringify({
        first: String(payload && typeof payload === "object" && "first" in payload ? payload.first || "" : ""),
        last: String(payload && typeof payload === "object" && "last" in payload ? payload.last || "" : ""),
    }));
});

Events.on("creatorCancelled", () => {
    if (!creationRequested) return;
    creationRequested = false;
    Events.emitServer("hmp-characters:cancelled", "{}");
});

ensureView();