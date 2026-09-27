import type { HmpControlLease, HmpLibClient } from "../../hmp-lib/types";
import type { HmpCharacterCard, HmpCharacterLook, HmpCharacterUiModel } from "../types";

const VIEW_URL = "fw://resources/hmp-characters/dist/index.html";
const CREATOR_VIEW_URL = "fw://resources/hmp-characters/dist/creator.html";
const READY_TIMEOUT_MS = 8000;
const CREATOR_READY_TIMEOUT_MS = 8000;
const PORTRAIT_PX = 96;
const PORTRAIT_POLL_MS = 50;
const PORTRAIT_RETRY_MS = 300;
const PORTRAIT_TIMEOUT_MS = 20_000;
const MAX_PORTRAIT_BYTES = 3 * 1024 * 1024;
const PORTRAIT_POSE = "/Game/Animation/Human/PhotoMode/Hu_PhotoMode_Stand3_01_pose_anm.Hu_PhotoMode_Stand3_01_pose_anm";
const Input = Imports.get<HmpLibClient>("hmp-lib").input;

interface ClientCharacter extends HmpCharacterCard {
    look?: HogwartsMpLook | null;
    transmog?: string;
    portrait?: string;
    portraitQueuedAt?: number;
}

type ClientModel = Omit<HmpCharacterUiModel, "characters"> & { characters: ClientCharacter[] };

let view = -1;
let pageReady = false;
let visible = false;
let creatorView = -1;
let creatorPageReady = false;
let creatorVisible = false;
let creatorDisplayed = false;
let creatorSnapshotReady = false;
let creatorWaitingForImport = false;
let creatorSchema: HogwartsMpCreatorSchema | null = null;
let creatorReadyTimer: ReturnType<typeof setTimeout> | null = null;
let controlLease: HmpControlLease | null = null;
let model: ClientModel | null = null;
let readyTimer: ReturnType<typeof setTimeout> | null = null;
let creationRequested = false;
let pendingImportLook: HogwartsMpLook | null = null;
let creatorInitialImport: HogwartsMpLook | null = null;

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

function ensureCreatorView(): number {
    if (creatorView >= 0) return creatorView;
    try { creatorView = Web.createView(CREATOR_VIEW_URL, { visible: false }); }
    catch (_) { creatorView = -1; }
    if (creatorView >= 0) wireCreator();
    return creatorView;
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
        Web.emit(view, "hmp-characters:export-state", { characterId: character.id, available: Boolean(character.look) });
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

function requestCreate(importedLook: HogwartsMpLook | null = null): void {
    if (creationRequested) return;
    creationRequested = true;
    pendingImportLook = importedLook;
    Events.emitServer("hmp-characters:create", "{}");
}

function hideCreator(unlock: boolean): void {
    if (creatorReadyTimer) { clearTimeout(creatorReadyTimer); creatorReadyTimer = null; }
    creatorVisible = false;
    creatorDisplayed = false;
    creatorSnapshotReady = false;
    creatorWaitingForImport = false;
    creatorInitialImport = null;
    creatorSchema = null;
    if (creatorView >= 0) Web.hideView(creatorView);
    try { CreatorPreview.restoreCamera(); }
    catch (_) { /* preview may not have started */ }
    try { CreatorPreview.freeze(false); }
    catch (_) { /* preview may not have started */ }
    if (unlock) lockControls(false);
}

function cancelCreator(message?: string): void {
    try { Creator.cancel(); }
    catch (_) { /* the session may already be gone */ }
    hideCreator(false);
    creationRequested = false;
    pendingImportLook = null;
    Events.emitServer("hmp-characters:cancelled", "{}");
    if (message) Game.notify(`[characters] ${message}`);
}

function readCreatorSnapshot(): { schema: HogwartsMpCreatorSchema; state: HogwartsMpCreatorState } | null {
    try {
        const schema = Creator.getSchema();
        const state = Creator.getState();
        if (!schema || !state) return null;
        creatorSchema = schema;
        return { schema, state };
    } catch (_) {
        return null;
    }
}

function pushCreatorSnapshot(): boolean {
    if (!creatorVisible || !creatorPageReady || creatorView < 0) return false;
    const snapshot = readCreatorSnapshot();
    if (!snapshot) return false;
    if (!creatorDisplayed) {
        creatorDisplayed = true;
        if (creatorReadyTimer) { clearTimeout(creatorReadyTimer); creatorReadyTimer = null; }
        Web.showView(creatorView);
        Web.focusView(creatorView);
        Web.emit(creatorView, "hmp-creator:open", snapshot);
    } else {
        Web.emit(creatorView, "hmp-creator:snapshot", snapshot);
    }
    return true;
}

function handleCreatorChanged(): void {
    if (!creatorVisible) return;
    if (creatorInitialImport) {
        const look = creatorInitialImport;
        creatorInitialImport = null;
        creatorWaitingForImport = true;
        let accepted = false;
        try { accepted = Creator.importLook(look); }
        catch (_) { accepted = false; }
        if (!accepted) cancelCreator("That JSON is not a valid character look.");
        return;
    }
    creatorWaitingForImport = false;
    creatorSnapshotReady = true;
    pushCreatorSnapshot();
}

function openCreator(): void {
    if (ensureCreatorView() < 0) {
        cancelCreator("The character creator page is not ready.");
        return;
    }
    let supported = false;
    let begun = false;
    try {
        const capabilities = Creator.getCapabilities();
        supported = Boolean(capabilities?.session && capabilities?.schema && capabilities?.state && capabilities?.patch && capabilities?.preview && capabilities?.look);
        if (supported) begun = Creator.begin({ preserveCurrent: true });
    } catch (_) {
        supported = false;
    }
    if (!supported || !begun) {
        cancelCreator(supported ? "Another character creator session is already active." : "This client does not support the Foundations character creator.");
        return;
    }
    hide(false);
    creatorVisible = true;
    creatorDisplayed = false;
    creatorSnapshotReady = false;
    creatorWaitingForImport = false;
    creatorInitialImport = pendingImportLook;
    pendingImportLook = null;
    lockControls(true);
    creatorReadyTimer = setTimeout(() => {
        if (creatorVisible && !creatorDisplayed) cancelCreator("The character creator did not become ready.");
    }, CREATOR_READY_TIMEOUT_MS);
}

function lookKey(character: ClientCharacter): string {
    return `${JSON.stringify(character.look || null)}|${character.transmog || ""}`;
}

function publishPortrait(key: string, src: string): void {
    portraits.set(key, src);
    if (!model) return;
    for (const character of model.characters) {
        if (!character.look || lookKey(character) !== key) continue;
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
    const look = character.look;
    let accepted = false;
    try {
        if (!look || typeof Portrait !== "object" || typeof Portrait.capture !== "function") {
            portraitQueue.shift();
            finishPortrait(key, "");
            return;
        }
        accepted = Portrait.capture({
            look,
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
    if (!character.look) {
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
    character.look = look.look && typeof look.look === "object" ? look.look : null;
    character.transmog = String(look.transmog || "");
    if (visible && pageReady && view >= 0) {
        Web.emit(view, "hmp-characters:export-state", { characterId: character.id, available: Boolean(character.look) });
    }
    enqueuePortrait(character);
}

function exportLook(characterId: unknown): void {
    const character = model?.characters.find((candidate) => candidate.id === Number(characterId));
    if (!character?.look) {
        if (view >= 0) Web.emit(view, "hmp-characters:error", { message: "That character's JSON look is not available." });
        return;
    }
    Web.emit(view, "hmp-characters:export", {
        characterId: character.id,
        name: character.name,
        json: JSON.stringify(character.look, null, 2),
    });
}

function importLook(payload: unknown): void {
    const source = payload && typeof payload === "object" && "look" in payload ? payload.look : null;
    let look: unknown = source;
    if (typeof source === "string") {
        try { look = JSON.parse(source); }
        catch (_) { look = null; }
    }
    if (!look || typeof look !== "object" || Array.isArray(look)) {
        if (view >= 0) Web.emit(view, "hmp-characters:error", { message: "Paste a valid JSON character look." });
        return;
    }
    requestCreate(look as HogwartsMpLook);
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

function creatorRecord(payload: unknown): Record<string, unknown> {
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
}

function creatorError(message: string): void {
    if (creatorView >= 0) Web.emit(creatorView, "hmp-creator:error", { message });
}

function finishCreator(payload: unknown): void {
    if (!creatorVisible || !creationRequested) return;
    const input = creatorRecord(payload);
    const first = String(input.first || "").trim();
    const last = String(input.last || "").trim();
    if (!first || !last) {
        creatorError("Enter a first and last name before confirming.");
        return;
    }
    let committed = false;
    try {
        Creator.setName(first, last);
        committed = Creator.commit();
    } catch (_) {
        committed = false;
    }
    if (!committed) {
        creatorError("The character creator session could not be committed.");
        return;
    }
    hideCreator(false);
    lockControls(true);
    Events.emitServer("hmp-characters:confirmed", JSON.stringify({ first, last }));
}

function wireCreator(): void {
    Web.on(creatorView, "creator:ready", () => {
        creatorPageReady = true;
        if (creatorVisible && creatorSnapshotReady && !creatorWaitingForImport) pushCreatorSnapshot();
    });
    Web.on(creatorView, "creator:cancel", () => {
        if (creatorVisible && creationRequested) cancelCreator();
    });
    Web.on(creatorView, "creator:confirm", (payload) => finishCreator(payload));
    Web.on(creatorView, "creator:option", (payload) => {
        if (!creatorVisible) return;
        const input = creatorRecord(payload);
        const category = String(input.category || "");
        const index = Math.trunc(Number(input.index));
        const schema = creatorSchema || readCreatorSnapshot()?.schema;
        const options = schema?.categories?.[category]?.options || [];
        const id = category === "glasses" ? (index === 1 ? "" : options[index - 2]) : options[index - 1];
        if (!category || index < 1 || id === undefined) {
            creatorError("That creator option is not available for this character.");
            return;
        }
        try {
            if (Creator.applyPatch({ [category]: id }) < 1) creatorError("That creator option was not accepted.");
        } catch (_) {
            creatorError("That creator option could not be applied.");
        }
    });
    Web.on(creatorView, "creator:voice", (payload) => {
        if (!creatorVisible) return;
        const input = creatorRecord(payload);
        const tone = Math.max(0, Math.min(1, Math.trunc(Number(input.tone)) || 0));
        const pitch = Math.max(-2, Math.min(2, Math.trunc(Number(input.pitch)) || 0));
        try { Creator.setVoice({ tone, pitch }); }
        catch (_) { creatorError("The voice setting could not be applied."); }
    });
    Web.on(creatorView, "creator:name", (payload) => {
        if (!creatorVisible) return;
        const input = creatorRecord(payload);
        try { Creator.setName(String(input.first || ""), String(input.last || "")); }
        catch (_) { creatorError("The character name could not be staged."); }
    });
    Web.on(creatorView, "creator:import", (payload) => {
        if (!creatorVisible) return;
        const look = creatorRecord(payload).look;
        let accepted = false;
        try { accepted = Boolean(look && typeof look === "object" && !Array.isArray(look) && Creator.importLook(look as HogwartsMpLook)); }
        catch (_) { accepted = false; }
        if (!accepted) creatorError("That JSON is not a valid character look.");
    });
    Web.on(creatorView, "creator:export", () => {
        if (!creatorVisible) return;
        let look: HogwartsMpLook | null = null;
        try { look = Creator.exportLook(); }
        catch (_) { look = null; }
        if (!look) {
            creatorError("The current character look is not ready to export.");
            return;
        }
        Web.emit(creatorView, "hmp-creator:export", { json: JSON.stringify(look, null, 2) });
    });
    Web.on(creatorView, "creator:camera", (payload) => {
        if (!creatorVisible) return;
        const input = creatorRecord(payload);
        try {
            CreatorPreview.setCamera({
                dist: Number(input.dist) || 160,
                height: Number(input.height) || 40,
                pitch: Number(input.pitch) || 0,
                fov: Number(input.fov) || 30,
                shift: Number(input.shift) || 0,
            });
        } catch (_) { creatorError("The creator camera could not be positioned."); }
    });
    Web.on(creatorView, "creator:rotate", (payload) => {
        if (!creatorVisible) return;
        try { CreatorPreview.rotate(Number(creatorRecord(payload).yaw) || 0); }
        catch (_) { /* rotation is optional */ }
    });
    Web.on(creatorView, "creator:freeze", (payload) => {
        if (!creatorVisible) return;
        try { CreatorPreview.freeze(creatorRecord(payload).frozen !== false); }
        catch (_) { /* freeze is optional */ }
    });
}

function wire(): void {
    Web.on(view, "ready", () => {
        pageReady = true;
        if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
        if (visible) push();
    });
    Web.on(view, "select", (payload) => Events.emitServer("hmp-characters:select", JSON.stringify(payload || {})));
    Web.on(view, "create", () => requestCreate());
    Web.on(view, "import", (payload) => importLook(payload));
    Web.on(view, "export", (payload) => exportLook(payload && typeof payload === "object" && "characterId" in payload ? payload.characterId : null));
    Web.on(view, "delete", (payload) => Events.emitServer("hmp-characters:delete", JSON.stringify(payload || {})));
    Web.on(view, "close", () => Events.emitServer("hmp-characters:close", "{}"));
}

Events.on("hmp-characters:open", (payload) => {
    model = normalizeModel(payload);
    creationRequested = false;
    pendingImportLook = null;
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
Events.on("creatorChanged", () => handleCreatorChanged());
Events.on("hmp-characters:error", (payload) => {
    creationRequested = false;
    pendingImportLook = null;
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

ensureView();
ensureCreatorView();
