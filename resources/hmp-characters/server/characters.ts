import type { HmpCharacterUiModel } from "../types";
import type { HmpCoreCharacter, HmpCoreSession } from "../../hmp-core/types";
import type {
    CharacterEventPayload,
    CharacterFlowOptions,
    CharacterNameInput,
    CharacterOpenOptions,
    Player,
} from "./internal";

interface PendingCreation {
    confirming: boolean;
    name?: string;
    revision?: number;
    timer?: ReturnType<typeof setTimeout>;
}

const MAX_LOOK_BYTES = 60_000;

function appearanceError(value: HogwartsMpAppearanceOperationError | unknown): Error {
    if (value instanceof Error) return value;
    const message = value && typeof value === "object" && "message" in value ? String(value.message) : String(value);
    return Object.assign(new Error(message), value && typeof value === "object" ? value : {});
}

function applyAppearanceBlob(player: Player, blob: string): Promise<HogwartsMpAppearanceOperationResult> {
    return new Promise((resolve, reject) => {
        if (typeof player?.setAppearanceBlob !== "function") {
            reject(Object.assign(new Error("native appearance application is unavailable"), { code: "HMP_CHARACTERS_APPEARANCE_UNAVAILABLE" }));
            return;
        }
        let settled = false;
        const done: HogwartsMpAppearanceCallback = (error, result) => {
            if (settled) return;
            settled = true;
            if (error) reject(appearanceError(error));
            else if (result) resolve(result);
            else reject(Object.assign(new Error("native appearance application returned no result"), { code: "HMP_CHARACTERS_APPEARANCE_INVALID_RESULT" }));
        };
        try { player.setAppearanceBlob(blob, done); }
        catch (error) { settled = true; reject(error); }
    });
}

function createCharacterFlow(options: CharacterFlowOptions) {
    const core = options.core;
    const events = options.events || null;
    const logger = options.logger || console;
    const config = options.config || {};
    if (!core?.sessions || !core?.characters || !core?.metadata) throw new TypeError("hmp-core API is required");

    const worldReady = new Set<number>();
    const loadingDone = new Set<number>();
    const initialOpened = new Set<number>();
    const pendingCreation = new Map<number, PendingCreation>();

    const playerId = (player: Player) => Number(player?.id);
    const connected = (player: Player) => Boolean(core.sessions.get(player));

    function send(player: Player, event: string, payload: unknown = {}): boolean {
        if (!player || typeof player.emit !== "function") return false;
        player.emit(event, JSON.stringify(payload));
        return true;
    }

    function notifyError(player: Player, error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        send(player, "hmp-characters:error", { message });
        if (logger && typeof logger.warn === "function") logger.warn(`Character action for #${playerId(player)} failed: ${message}`);
    }

    function clearPending(player: Player): PendingCreation | null {
        const id = playerId(player);
        const pending = pendingCreation.get(id) || null;
        if (pending?.timer) clearTimeout(pending.timer);
        pendingCreation.delete(id);
        return pending;
    }

    async function askMaySwitch(player: Player, character: HmpCoreCharacter): Promise<void> {
        const active = core.characters.active(player);
        if (!active || active.id === character.id || !events || typeof events.emit !== "function") return;
        const request = { player, from: active, to: character, allow: true, reason: "" };
        try { await events.emit("hmp:character:may-switch", request); }
        catch (error) {
            if (logger && typeof logger.error === "function") logger.error(`Character switch policy failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (request.allow === false) {
            const denied = new Error(String(request.reason || "You cannot change character right now."));
            throw Object.assign(denied, { code: "HMP_CHARACTERS_SWITCH_DENIED" });
        }
    }

    async function model(player: Player, mode: string): Promise<HmpCharacterUiModel> {
        const session = core.sessions.get(player);
        if (!session) throw new Error("Your account session is not ready yet.");
        const characters = await core.characters.list(player);
        const active = core.characters.active(player);
        const lastCharacterId = Number(await core.metadata.getAccount(session.account.id, "hmp-characters:last")) || null;
        const limit = core.characters.limit();
        return {
            mode,
            title: String(config.title || "Choose Your Wizard"),
            subtitle: String(config.subtitle || "Every story begins with a name."),
            characters: characters.map((character) => ({
                id: character.id,
                slot: character.slot,
                name: character.name,
            })),
            activeCharacterId: active?.id || null,
            lastCharacterId,
            limit,
            full: characters.length >= limit,
            allowDelete: config.allowDelete !== false,
            canClose: mode !== "join" && mode !== "create" && Boolean(active) && config.allowCloseWithActiveCharacter === true,
        };
    }

    async function sendLooks(player: Player, characters: HmpCharacterUiModel["characters"]): Promise<void> {
        for (const character of characters) {
            let appearance = "";
            let transmog = "";
            try {
                appearance = String(await core.metadata.getCharacter(character.id, "appearance") || "");
                transmog = String(await core.metadata.getCharacter(character.id, "transmog") || "");
            } catch (error) {
                if (logger && typeof logger.warn === "function") {
                    logger.warn(`Could not load portrait data for character ${character.id}: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            if (!connected(player)) return;
            if (Buffer.byteLength(appearance, "utf8") > MAX_LOOK_BYTES) {
                if (logger && typeof logger.warn === "function") {
                    logger.warn(`Character ${character.id} appearance exceeds the portrait event limit; using the initials fallback`);
                }
                appearance = "";
                transmog = "";
            }
            send(player, "hmp-characters:look", { characterId: character.id, appearance, transmog });
        }
    }

    async function open(player: Player, openOptions: CharacterOpenOptions = {}): Promise<HmpCharacterUiModel> {
        let mode = String(openOptions.mode || "wardrobe");
        const characters = await core.characters.list(player);
        if (!characters.length && openOptions.autoCreate !== false) mode = "create";
        const payload = await model(player, mode);
        send(player, "hmp-characters:open", payload);
        await sendLooks(player, payload.characters);
        return payload;
    }

    function close(player: Player): boolean {
        clearPending(player);
        send(player, "hmp-characters:close");
        return true;
    }

    async function tryInitialOpen(player: Player): Promise<boolean> {
        const id = playerId(player);
        if (!config.autoOpenOnJoin || initialOpened.has(id) || !worldReady.has(id) || !loadingDone.has(id) || !connected(player)) return false;
        if (core.characters.active(player)) {
            initialOpened.add(id);
            return false;
        }
        initialOpened.add(id);
        try {
            await open(player, { mode: "join" });
            return true;
        } catch (error) {
            initialOpened.delete(id);
            throw error;
        }
    }

    async function onWorldReady(player: Player): Promise<boolean> {
        worldReady.add(playerId(player));
        return tryInitialOpen(player);
    }

    async function onLoadingFinished(player: Player): Promise<boolean> {
        const id = playerId(player);
        loadingDone.add(id);
        return tryInitialOpen(player);
    }

    async function onSessionReady(session: HmpCoreSession<Player>): Promise<boolean> {
        return tryInitialOpen(session.player);
    }

    async function select(player: Player, characterId: unknown): Promise<HmpCoreCharacter> {
        const wanted = Number(characterId);
        const character = (await core.characters.list(player)).find((entry) => entry.id === wanted);
        if (!character) throw new Error("That character is no longer available.");
        await askMaySwitch(player, character);
        const selected = await core.characters.select(player, wanted);
        const session = core.sessions.get(player);
        await core.metadata.setAccount((session as HmpCoreSession<Player>).account.id, "hmp-characters:last", selected.id);
        close(player);
        return selected;
    }

    async function beginCreate(player: Player): Promise<boolean> {
        const list = await core.characters.list(player);
        if (list.length >= core.characters.limit()) throw new Error("All character slots are already in use.");
        clearPending(player);
        pendingCreation.set(playerId(player), { confirming: false });
        send(player, "hmp-characters:create");
        return true;
    }

    function cleanPart(value: unknown): string {
        return String(value ?? "")
            .normalize("NFKC")
            .replace(/[^\p{L}\p{M}' -]/gu, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 32);
    }

    function characterName(player: Player, input: CharacterNameInput): string {
        const first = cleanPart(input?.first);
        const last = cleanPart(input?.last);
        const creatorName = `${first} ${last}`.trim();
        const fallback = cleanPart(player?.nickname) || "New Student";
        return (creatorName || fallback).slice(0, 80);
    }

    async function confirmCreate(player: Player, input: CharacterNameInput): Promise<boolean> {
        const id = playerId(player);
        const pending = pendingCreation.get(id);
        if (!pending || pending.confirming) throw new Error("No character creation is pending.");
        pending.confirming = true;
        pending.name = characterName(player, input);
        pending.revision = Math.max(0, Math.trunc(Number(player.appearanceRevision)) || 0);
        pending.timer = setTimeout(() => {
            if (pendingCreation.get(id) !== pending) return;
            pendingCreation.delete(id);
            if (connected(player)) notifyError(player, new Error("Your look did not finish applying, so the character was not saved."));
        }, Number(config.appearanceTimeoutMs || 6000));
        return true;
    }

    async function onAppearanceChanged(player: Player, blob: unknown, revision: unknown): Promise<HmpCoreCharacter | null> {
        const pending = pendingCreation.get(playerId(player));
        const publishedRevision = Math.max(0, Math.trunc(Number(revision)) || 0);
        if (!pending?.confirming || !pending.name || publishedRevision <= Number(pending.revision || 0)) return null;
        const appearance = String(blob || "");
        if (!appearance) return null;
        clearPending(player);
        try {
            if (!connected(player)) return null;
            const character = await core.characters.create(player, { name: pending.name });
            await core.metadata.setCharacter(character.id, "appearance", appearance);
            let transmog = "";
            try { transmog = String(player.getTransmog?.() || ""); }
            catch (_) { transmog = ""; }
            if (transmog) await core.metadata.setCharacter(character.id, "transmog", transmog);
            await select(player, character.id);
            send(player, "hmp-characters:saved", { character: { id: character.id, slot: character.slot, name: character.name } });
            return character;
        } catch (error) {
            if (connected(player)) await open(player, { mode: core.characters.active(player) ? "wardrobe" : "join", autoCreate: false });
            throw error;
        }
    }

    async function cancelCreate(player: Player): Promise<HmpCharacterUiModel> {
        clearPending(player);
        return open(player, { mode: core.characters.active(player) ? "wardrobe" : "join", autoCreate: false });
    }

    async function remove(player: Player, characterId: unknown): Promise<HmpCharacterUiModel> {
        if (config.allowDelete === false) throw new Error("Character deletion is disabled.");
        const wanted = Number(characterId);
        const active = core.characters.active(player);
        if (active?.id === wanted) throw new Error("Switch characters before deleting this one.");
        const deleted = await core.characters.delete(player, wanted);
        if (!deleted) throw new Error("That character is no longer available.");
        const session = core.sessions.get(player);
        const activeSession = session as HmpCoreSession<Player>;
        const last = Number(await core.metadata.getAccount(activeSession.account.id, "hmp-characters:last"));
        if (last === wanted) await core.metadata.deleteAccount(activeSession.account.id, "hmp-characters:last");
        return open(player, { mode: active ? "wardrobe" : "join" });
    }

    async function applyAppearance(payload: CharacterEventPayload): Promise<boolean> {
        const player = payload?.session?.player;
        const character = payload?.character;
        if (!player || !character) return false;
        const appearance = await core.metadata.getCharacter(character.id, "appearance");
        const transmog = await core.metadata.getCharacter(character.id, "transmog");
        if (appearance) await applyAppearanceBlob(player, String(appearance));
        if (typeof player.setTransmog === "function") player.setTransmog(transmog ? String(transmog) : "");
        return Boolean(appearance || transmog);
    }

    function disconnect(player: Player): void {
        const id = playerId(player);
        worldReady.delete(id);
        loadingDone.delete(id);
        initialOpened.delete(id);
        clearPending(player);
    }

    return Object.freeze({
        open,
        close,
        select,
        beginCreate,
        confirmCreate,
        onAppearanceChanged,
        cancelCreate,
        remove,
        applyAppearance,
        onWorldReady,
        onLoadingFinished,
        onSessionReady,
        disconnect,
        notifyError,
        pending: (player: Player) => pendingCreation.has(playerId(player)),
    });
}

export = { createCharacterFlow };
// TypeScript source.
