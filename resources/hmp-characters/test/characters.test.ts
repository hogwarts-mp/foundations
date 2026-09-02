import assert = require("node:assert");
import { test } from "node:test";
import charactersModule = require("../server/characters");
import type { HmpCoreCharacter, HmpCoreSession } from "../../hmp-core/types";
import type { CharacterConfig, Core, Player } from "../server/internal";

const { createCharacterFlow } = charactersModule;

function hasCode(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

interface TestPlayer extends Player {
    appearance: string;
    transmog: string;
    appliedAppearance?: string;
    appliedTransmog?: string;
    appearanceError?: HogwartsMpAppearanceOperationError;
    appearanceOrder: string[];
}

interface TestConfig extends Partial<CharacterConfig> { denySwitch?: boolean }
interface RecordedEvent { name: string; payload: unknown }
interface ClientEvent { name: string; payload: Record<string, unknown> }

function makeCharacter(id: number, slot: number, name: string): HmpCoreCharacter {
    return { id, accountId: 10, slot, name, status: "active", createdAt: "now", updatedAt: "now", deletedAt: null };
}

function setup(config: TestConfig = {}) {
    let nextCharacter = 1;
    const emitted: RecordedEvent[] = [];
    const clientEvents: ClientEvent[] = [];
    const characters: HmpCoreCharacter[] = [];
    const active = new Map<number, HmpCoreCharacter>();
    const metadata = new Map<string, unknown>();
    const player: TestPlayer = {
        id: 7,
        nickname: "Poppy Sweeting",
        position: { x: 0, y: 0, z: 0 },
        appearance: "before",
        appearanceRevision: 2,
        transmog: "",
        appearanceOrder: [],
        emit(name: string, payload?: unknown) { clientEvents.push({ name, payload: JSON.parse(typeof payload === "string" ? payload : "{}") as Record<string, unknown> }); },
        teleport: () => 0,
        getAppearanceBlob() { return this.appearance; },
        setAppearanceBlob(value: string, callback?: HogwartsMpAppearanceCallback) {
            this.appearanceOrder.push("appearance");
            this.appliedAppearance = value;
            if (this.appearanceError) callback?.(this.appearanceError, null);
            else callback?.(null, { revision: 2 });
            return callback ? 21 : 0;
        },
        getTransmog() { return this.transmog; },
        setTransmog(value: string) { this.appearanceOrder.push("transmog"); this.appliedTransmog = value; },
    };
    const session: HmpCoreSession<TestPlayer> = {
        player,
        playerId: player.id,
        account: { id: 10, displayName: "Poppy", createdAt: "now", lastSeenAt: "now" },
        principal: { provider: "test", subject: "poppy", trust: "verified" },
        character: null,
        connectedAt: "now",
    };
    const core = {
        sessions: { get: (candidate: TestPlayer | number) => Number(typeof candidate === "number" ? candidate : candidate?.id) === player.id ? session : null },
        characters: {
            list: async () => characters.filter((character) => character.status === "active"),
            create: async (_player: TestPlayer, input: { name: string }) => {
                const used = new Set(characters.filter((entry) => entry.status === "active").map((entry) => entry.slot));
                const slot = [1, 2, 3].find((value) => !used.has(value));
                if (slot === undefined) throw new Error("no test character slot");
                const character = makeCharacter(nextCharacter++, slot, input.name);
                characters.push(character);
                return character;
            },
            async select(_player: TestPlayer, id: number) {
                const character = characters.find((entry) => entry.id === Number(id));
                if (!character) throw new Error("test character not found");
                active.set(player.id, character);
                session.character = character;
                await events.emit("hmp:character:selected", { session, character });
                return character;
            },
            active: () => active.get(player.id) || null,
            async delete(_player: TestPlayer, id: number) {
                const character = characters.find((entry) => entry.id === Number(id) && entry.status === "active");
                if (!character) return false;
                character.status = "deleted";
                return true;
            },
            limit: () => 3,
        },
        metadata: {
            getAccount: async (id: number, key: string) => metadata.get(`account:${id}:${key}`),
            setAccount: async (id: number, key: string, value: unknown) => { metadata.set(`account:${id}:${key}`, value); return value; },
            deleteAccount: async (id: number, key: string) => metadata.delete(`account:${id}:${key}`),
            getCharacter: async (id: number, key: string) => metadata.get(`character:${id}:${key}`),
            setCharacter: async (id: number, key: string, value: unknown) => { metadata.set(`character:${id}:${key}`, value); return value; },
        },
    } as unknown as Core;
    const events = {
        async emit(name: string, payload: unknown) {
            emitted.push({ name, payload });
            if (name === "hmp:character:may-switch" && config.denySwitch && payload && typeof payload === "object") {
                const objection = payload as { allow?: boolean; reason?: string };
                objection.allow = false;
                objection.reason = "Finish your current activity first.";
            }
        },
    };
    const flow = createCharacterFlow({
        core,
        events,
        logger: { warn: () => true, error: () => true },
        config: {
            autoOpenOnJoin: true,
            allowDelete: true,
            allowCloseWithActiveCharacter: true,
            appearanceTimeoutMs: 500,
            ...config,
        },
    });
    return { flow, core, player, session, characters, metadata, emitted, clientEvents };
}

test("opens only after account, client and world readiness", async () => {
    const { flow, session, player, clientEvents } = setup();
    assert.strictEqual(await flow.onSessionReady(session), false);
    assert.strictEqual(await flow.onLoadingFinished(player), false);
    assert.strictEqual(await flow.onWorldReady(player), true);
    const opened = clientEvents.find((event) => event.name === "hmp-characters:open");
    assert.strictEqual(opened?.payload.mode, "create");
    assert.strictEqual(opened?.payload.canClose, false);
    assert.strictEqual(opened?.payload.limit, 3);
});

test("streams saved looks separately after the lightweight card model", async () => {
    const { flow, core, player, metadata, clientEvents } = setup();
    const first = await core.characters.create(player, { name: "Poppy Sweeting" });
    const second = await core.characters.create(player, { name: "Garreth Weasley" });
    metadata.set(`character:${first.id}:appearance`, "saved-look");
    metadata.set(`character:${first.id}:transmog`, "ProfessorGarlick");
    metadata.set(`character:${second.id}:appearance`, "x".repeat(60_001));

    await flow.open(player, { mode: "wardrobe", autoCreate: false });

    const opened = clientEvents.find((event) => event.name === "hmp-characters:open");
    assert.deepStrictEqual(opened?.payload.characters, [
        { id: first.id, slot: first.slot, name: first.name },
        { id: second.id, slot: second.slot, name: second.name },
    ]);
    const looks = clientEvents.filter((event) => event.name === "hmp-characters:look").map((event) => event.payload);
    assert.deepStrictEqual(looks, [
        { characterId: first.id, appearance: "saved-look", transmog: "ProfessorGarlick" },
        { characterId: second.id, appearance: "", transmog: "" },
    ]);
});

test("creates a character with the post-creator appearance and selects it", async () => {
    const { flow, player, characters, metadata, emitted, clientEvents } = setup();
    await flow.beginCreate(player);
    assert.strictEqual(flow.pending(player), true);
    assert.ok(clientEvents.some((event) => event.name === "hmp-characters:create"));

    player.appearance = "intermediate";
    assert.strictEqual(await flow.confirmCreate(player, { first: " Poppy ", last: " Sweeting<script> " }), true);
    assert.strictEqual(await flow.onAppearanceChanged(player, "intermediate", 2), null);
    assert.strictEqual(characters.length, 0);

    const character = await flow.onAppearanceChanged(player, "after", 3);
    assert.ok(character);
    assert.strictEqual(character.name, "Poppy Sweetingscript");
    assert.strictEqual(characters.length, 1);
    assert.strictEqual(metadata.get(`character:${character.id}:appearance`), "after");
    assert.strictEqual(metadata.get("account:10:hmp-characters:last"), character.id);
    assert.ok(clientEvents.some((event) => event.name === "hmp-characters:close"));
    assert.ok(clientEvents.some((event) => event.name === "hmp-characters:saved"));
    assert.ok(emitted.some((event) => event.name === "hmp:character:selected"));
});

test("applies stored appearance during the loading lifecycle", async () => {
    const { flow, player, session, metadata } = setup();
    const character = makeCharacter(3, 1, "Natsai Onai");
    metadata.set("character:3:appearance", "saved-look");
    metadata.set("character:3:transmog", "EleazarFig");
    assert.strictEqual(await flow.applyAppearance({ session, character }), true);
    assert.strictEqual(player.appliedAppearance, "saved-look");
    assert.strictEqual(player.appliedTransmog, "EleazarFig");
    assert.deepStrictEqual(player.appearanceOrder, ["appearance", "transmog"]);
});

test("does not restore transmog when native appearance reload fails", async () => {
    const { flow, player, session, metadata } = setup();
    const character = makeCharacter(4, 1, "Sebastian Sallow");
    metadata.set("character:4:appearance", "saved-look");
    metadata.set("character:4:transmog", "EleazarFig");
    player.appearanceError = { code: "APPEARANCE_APPLY_FAILED", message: "reload failed" };
    await assert.rejects(() => flow.applyAppearance({ session, character }), (error: unknown) => hasCode(error, "APPEARANCE_APPLY_FAILED"));
    assert.deepStrictEqual(player.appearanceOrder, ["appearance"]);
    assert.strictEqual(player.appliedTransmog, undefined);
});

test("honors switch objections and protects the active character from deletion", async () => {
    const { flow, core, player, characters } = setup({ denySwitch: true });
    const first = await core.characters.create(player, { name: "First" });
    const second = await core.characters.create(player, { name: "Second" });
    await core.characters.select(player, first.id);
    await assert.rejects(() => flow.select(player, second.id), /Finish your current activity/);
    await assert.rejects(() => flow.remove(player, first.id), /Switch characters/);
    assert.strictEqual(await flow.remove(player, second.id).then(() => true), true);
    assert.strictEqual(characters.find((entry) => entry.id === second.id)?.status, "deleted");
});

test("cancelling mandatory creation returns to a non-closing selector without reopening it", async () => {
    const { flow, player, clientEvents } = setup();
    await flow.beginCreate(player);
    const model = await flow.cancelCreate(player);
    assert.strictEqual(model.mode, "join");
    assert.strictEqual(model.canClose, false);
    assert.strictEqual(flow.pending(player), false);
    assert.strictEqual(clientEvents.filter((event) => event.name === "hmp-characters:create").length, 1);
});
// Source-level TypeScript tests.
