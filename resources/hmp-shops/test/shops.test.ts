import assert = require("node:assert");
import { test } from "node:test";
import configModule = require("../server/config");
import normalizeModule = require("../shared/normalize");
import serviceModule = require("../server/service");
import type { HmpShopTransaction } from "../types";
import type { Player, ShopsRepository, TransactionDraft } from "../server/internal";

const { normalizeConfig } = configModule;
const { normalizeShop } = normalizeModule;
const { createShopsService } = serviceModule;

function setup() {
    let clock = 1000;
    let nextTransactionId = 1;
    const player = { id: 7, nickname: "Poppy", position: { x: 0, y: 0, z: 0 }, emit() {}, teleport: () => 0 } as Player;
    const counts = new Map<string, number>([["native:galleons", 100], ["potion", 2], ["ingredient", 0]]);
    const stocks = new Map<string, number>();
    const transactions = new Map<string, HmpShopTransaction>();
    const interactions = new Map<string, unknown>();
    const notifications: unknown[] = [];
    const menus: unknown[] = [];
    const inputs: unknown[] = [];
    const alerts: unknown[] = [];
    const emitted: Array<{ name: string; payload: unknown }> = [];
    const contextChoices: Array<string | null> = [];
    const inputChoices: Array<Record<string, string | number | boolean> | null> = [];
    const alertChoices: Array<"confirm" | "cancel" | null> = [];
    const failAdds = new Map<string, number>();

    const repository: ShopsRepository = {
        async migrate() {},
        async ensureStock(shopId, offerId, quantity) {
            const key = `${shopId}:${offerId}`;
            if (!stocks.has(key)) stocks.set(key, quantity);
            return stocks.get(key)!;
        },
        async getStock(shopId, offerId) { return stocks.get(`${shopId}:${offerId}`) ?? null; },
        async reserveStock(shopId, offerId, quantity) {
            const key = `${shopId}:${offerId}`;
            const current = stocks.get(key);
            if (current === undefined || current < quantity) return false;
            stocks.set(key, current - quantity);
            return true;
        },
        async adjustStock(shopId, offerId, delta) {
            const key = `${shopId}:${offerId}`;
            const next = (stocks.get(key) ?? 0) + delta;
            if (next < 0) throw new Error("negative stock");
            stocks.set(key, next);
            return next;
        },
        async setStock(shopId, offerId, quantity) { stocks.set(`${shopId}:${offerId}`, quantity); return quantity; },
        async begin(draft: TransactionDraft) {
            const existing = transactions.get(draft.reference);
            if (existing) return { created: false, transaction: existing };
            const transaction: HmpShopTransaction = {
                id: nextTransactionId++, reference: draft.reference, characterId: draft.characterId, shopId: draft.shopId,
                offerId: draft.offerId, item: draft.item, direction: draft.direction, quantity: draft.quantity,
                unitPrice: draft.unitPrice, totalPrice: draft.totalPrice, currency: draft.currency, status: "pending",
                error: "", createdAt: new Date(0), completedAt: null,
            };
            transactions.set(draft.reference, transaction);
            return { created: true, transaction };
        },
        async finish(reference, status, error = "") {
            const transaction = transactions.get(reference)!;
            transaction.status = status;
            transaction.error = error;
            transaction.completedAt = new Date(1);
            return { ...transaction };
        },
        async history(characterId, limit) { return [...transactions.values()].filter((entry) => entry.characterId === characterId).slice(-limit).reverse(); },
    };

    const inventory = {
        items: {
            get(name: string) {
                if (!["native:galleons", "potion", "ingredient"].includes(name)) return null;
                return { name, label: name === "native:galleons" ? "Galleons" : name === "potion" ? "Potion" : "Ingredient", description: `${name} description`, icon: "" };
            },
        },
        inventory: {
            async count(_player: Player, name: string) { return counts.get(name) || 0; },
            async has(_player: Player, name: string, amount = 1) { return (counts.get(name) || 0) >= amount; },
            async add(_player: Player, name: string, amount = 1) {
                const failures = failAdds.get(name) || 0;
                if (failures > 0) { failAdds.set(name, failures - 1); throw new Error(`failed to add ${name}`); }
                counts.set(name, (counts.get(name) || 0) + amount);
                return amount;
            },
            async remove(_player: Player, name: string, amount = 1) {
                const current = counts.get(name) || 0;
                if (current < amount) throw new Error(`not enough ${name}`);
                counts.set(name, current - amount);
                return amount;
            },
        },
    };

    const service = createShopsService({
        repository,
        core: { characters: { active: () => ({ id: 12 }) }, groups: { has: async () => true } } as never,
        inventory: inventory as never,
        interact: {
            register(definition: { id: string }) {
                interactions.set(definition.id, definition);
                return () => interactions.delete(definition.id);
            },
        } as never,
        ui: {
            notify(_player: Player, value: unknown) { notifications.push(value); return true; },
            async context(_player: Player, value: unknown) { menus.push(value); return contextChoices.shift() ?? null; },
            async input(_player: Player, value: unknown) { inputs.push(value); return inputChoices.shift() ?? null; },
            async alert(_player: Player, value: unknown) { alerts.push(value); return alertChoices.shift() ?? null; },
        } as never,
        events: { emit(name, payload) { emitted.push({ name, payload }); } },
        logger: { info: () => true, warn: () => true, error: () => true },
        migrations: [],
        now: () => clock,
    });

    return {
        service, player, counts, stocks, transactions, interactions, notifications, menus, inputs, alerts, emitted,
        contextChoices, inputChoices, alertChoices, failAdd(name: string, times = 1) { failAdds.set(name, times); },
        advance(ms: number) { clock += ms; },
    };
}

function shop() {
    return {
        id: "potions",
        resource: "hmp-potions",
        label: "J. Pippin's Potions",
        description: "Potions and ingredients",
        interaction: { position: { x: 0, y: 0, z: 0 }, radius: 250, character: { characterId: "PercivalPippin", label: "Parry Pippin" } },
        offers: [
            { id: "potion", item: "potion", buyPrice: 10, sellPrice: 4, stock: 5, maxQuantity: 10 },
            { id: "ingredient", item: "ingredient", buyPrice: 2 },
        ],
    } as const;
}

test("normalizes bounded catalogs and rejects ambiguous offers", () => {
    const normalized = normalizeShop(shop());
    assert.strictEqual(normalized.currency, "galleons");
    assert.strictEqual(normalized.offers[0].stock, 5);
    assert.throws(() => normalizeShop({ ...shop(), offers: [shop().offers[0], shop().offers[0]] }), /duplicated/);
    assert.throws(() => normalizeShop({ ...shop(), offers: [{ id: "none", item: "potion" }] }), /buyPrice or sellPrice/);
});

test("normalizes data-configured shops and rejects malformed entries", () => {
    const config = normalizeConfig({ shops: [{ ...shop(), resource: "ignored" }] });
    assert.strictEqual(config.shops.length, 1);
    assert.strictEqual(config.shops[0].resource, "hmp-shops");
    assert.strictEqual(config.shops[0].interaction?.character?.characterId, "PercivalPippin");
    assert.deepStrictEqual(normalizeConfig({}).shops, []);
    assert.throws(() => normalizeConfig({ shops: {} }), /must be an array/);
    assert.throws(() => normalizeConfig({ shops: [{ ...shop(), offers: [] }] }), /at least one offer/);
    assert.throws(() => normalizeConfig({ shops: [shop(), shop()] }), /twice/);
});

test("registers an interaction, initializes persistent stock and cleans by owner", async () => {
    const state = setup();
    await state.service.start();
    const dispose = state.service.shops.register(shop());
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(state.interactions.has("shop:potions"));
    const registered = state.interactions.get("shop:potions") as { character?: { characterId: string; label?: string } };
    assert.deepStrictEqual(registered.character, { characterId: "PercivalPippin", label: "Parry Pippin" });
    assert.strictEqual(await state.service.stock.get("potions", "potion"), 5);
    assert.strictEqual(dispose(), true);
    assert.strictEqual(dispose(), false);
    assert.strictEqual(state.interactions.has("shop:potions"), false);
});

test("buys limited stock, debits native Galleons and replays completed references", async () => {
    const state = setup();
    await state.service.start();
    state.service.shops.register(shop());
    const transaction = await state.service.transactions.buy(state.player, "potions", "potion", 2, { reference: "buy-once" });
    assert.strictEqual(transaction.status, "completed");
    assert.strictEqual(state.counts.get("native:galleons"), 80);
    assert.strictEqual(state.counts.get("potion"), 4);
    assert.strictEqual(await state.service.stock.get("potions", "potion"), 3);
    const replay = await state.service.transactions.buy(state.player, "potions", "potion", 2, { reference: "buy-once" });
    assert.strictEqual(replay.id, transaction.id);
    assert.strictEqual(state.counts.get("native:galleons"), 80);
});

test("rolls stock back on insufficient funds and compensates failed grants", async () => {
    const state = setup();
    await state.service.start();
    state.service.shops.register(shop());
    state.counts.set("native:galleons", 5);
    await assert.rejects(state.service.transactions.buy(state.player, "potions", "potion", 1, { reference: "poor" }), /enough Galleons/);
    assert.strictEqual(await state.service.stock.get("potions", "potion"), 5);
    assert.strictEqual(state.transactions.get("poor")?.status, "failed");

    state.counts.set("native:galleons", 100);
    state.failAdd("potion");
    await assert.rejects(state.service.transactions.buy(state.player, "potions", "potion", 1, { reference: "grant-fails" }), /failed to add potion/);
    assert.strictEqual(state.counts.get("native:galleons"), 100);
    assert.strictEqual(await state.service.stock.get("potions", "potion"), 5);
    assert.strictEqual(state.transactions.get("grant-fails")?.status, "compensated");
});

test("sells items, raises limited stock and compensates refused payment", async () => {
    const state = setup();
    await state.service.start();
    state.service.shops.register(shop());
    const sold = await state.service.transactions.sell(state.player, "potions", "potion", 1, { reference: "sell-one" });
    assert.strictEqual(sold.status, "completed");
    assert.strictEqual(state.counts.get("potion"), 1);
    assert.strictEqual(state.counts.get("native:galleons"), 104);
    assert.strictEqual(await state.service.stock.get("potions", "potion"), 6);

    state.failAdd("native:galleons");
    await assert.rejects(state.service.transactions.sell(state.player, "potions", "potion", 1, { reference: "pay-fails" }), /failed to add native:galleons/);
    assert.strictEqual(state.counts.get("potion"), 1);
    assert.strictEqual(await state.service.stock.get("potions", "potion"), 6);
    assert.strictEqual(state.transactions.get("pay-fails")?.status, "compensated");
});

test("drives the whole purchase menu from server-held catalog and prices", async () => {
    const state = setup();
    await state.service.start();
    state.service.shops.register(shop());
    state.contextChoices.push("potion", "buy");
    state.inputChoices.push({ quantity: 2 });
    state.alertChoices.push("confirm");
    const transaction = await state.service.shops.open(state.player, "potions");
    assert.strictEqual(transaction?.status, "completed");
    assert.strictEqual(transaction?.totalPrice, 20);
    assert.strictEqual(state.menus.length, 2);
    assert.strictEqual(state.inputs.length, 1);
    assert.strictEqual(state.alerts.length, 1);
    assert.ok(state.notifications.some((value) => JSON.stringify(value).includes("Purchased")));
});
