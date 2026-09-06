import assert = require("node:assert");
import { test } from "node:test";
import configModule = require("../server/config");
import commandsModule = require("../server/commands");
import normalizeModule = require("../shared/normalize");
import serviceModule = require("../server/service");
import type { HmpShopCurrencyProvider, HmpShopDefinition } from "../../hmp-shops/types";
import type { HmpBusiness, HmpBusinessAuditEntry, HmpBusinessOffer, HmpBusinessShop } from "../types";
import type { AuditDraft, BusinessRepository, BusinessService, CommandConfig, Core, Logger, Player } from "../server/internal";
import type { HmpCommandContext, HmpCommandRouter } from "../../hmp-lib/types";

const { normalizeConfig } = configModule;
const { registerCommands } = commandsModule;
const { normalizeBusiness, normalizeShop, normalizeOffer, shopKey } = normalizeModule;
const { createBusinessService, compactReference } = serviceModule;

test("opens the business console from the bare command while keeping fallbacks administrator-only", async () => {
    let guard: ((context: HmpCommandContext<Player>) => unknown) | null = null;
    let handler: ((context: HmpCommandContext<Player>) => unknown) | null = null;
    const router = {
        register(_name: string, options: { guard: (context: HmpCommandContext<Player>) => unknown }, callback: (context: HmpCommandContext<Player>) => unknown) {
            guard = options.guard;
            handler = callback;
            return () => true;
        },
    } as unknown as HmpCommandRouter<Player>;
    const player = { id: 77, nickname: "Manager", position: { x: 0, y: 0, z: 0 } } as unknown as Player;
    const opened: Array<string | undefined> = [];
    const service = { businesses: { managed: async () => [{ id: "pippins" }] } } as unknown as BusinessService;
    const core = { groups: { has: async () => false } } as unknown as Core;
    const config = { enabled: true, command: "business", adminGroups: [{ key: "admin", minimumGrade: 1 }] } as CommandConfig;
    const logger = { info() {}, warn() {}, error() {} } as Logger;
    registerCommands({ router, service, core, config, logger, open: async (_player, businessId) => { opened.push(businessId); return true; } });
    const context = { player, args: [], command: "business", invokedAs: "business", message: "/business", usage: "/business [action]", reply: () => true } as unknown as HmpCommandContext<Player>;
    assert.strictEqual(await guard!(context), true);
    await handler!(context);
    assert.deepStrictEqual(opened, [undefined]);
    assert.strictEqual(await guard!({ ...context, args: ["list"] }), "You are not allowed to administer businesses.");
});

const COUNTER = { x: 1000, y: 2000, z: 300 };
const JOB = { id: "pippins", resource: "hmp-hogsmeade", label: "J. Pippin's Potions", group: "job:pippins", grades: [], banking: { organizationId: "pippins", currency: "galleons" } };

function setup(overrides: { houseCutPercent?: number; jobRegistered?: boolean; buybacks?: boolean } = {}) {
    let clock = 1_000_000;
    let nextAuditId = 1;
    const josh = { id: 7, nickname: "Josh", position: { x: 0, y: 0, z: 0 }, emit() {}, teleport: () => 0 } as unknown as Player;
    const clerk = { id: 8, nickname: "Clerk", position: { x: 1050, y: 2000, z: 300 }, emit() {}, teleport: () => 0 } as unknown as Player;
    const customer = { id: 9, nickname: "Customer", position: { x: 0, y: 0, z: 0 }, emit() {}, teleport: () => 0 } as unknown as Player;
    const players = new Map<number, Player>([[7, josh], [8, clerk], [9, customer]]);
    const characterOf = (player: Player | number) => ({ 7: 12, 8: 13, 9: 14 } as Record<number, number>)[typeof player === "number" ? player : player.id];
    const managers = new Set<number>([12]);
    const staff = new Set<number>([12, 13]);
    const duties: Array<{ playerId: number; characterId: number; jobId: string; since: Date }> = [];
    let jobRegistered = overrides.jobRegistered !== false;

    const businesses = new Map<string, HmpBusiness>();
    const shopRows = new Map<string, HmpBusinessShop>();
    const offerRows = new Map<string, HmpBusinessOffer>();
    const audits: HmpBusinessAuditEntry[] = [];
    const repository: BusinessRepository = {
        async migrate() {},
        async loadAll() { return { businesses: [...businesses.values()], shops: [...shopRows.values()], offers: [...offerRows.values()] }; },
        async createBusiness(values) {
            if (businesses.has(values.id)) return null;
            const business = { ...values, createdAt: new Date(clock), updatedAt: new Date(clock) };
            businesses.set(values.id, business);
            return business;
        },
        async updateBusiness(values) {
            const business = { ...businesses.get(values.id)!, ...values, updatedAt: new Date(clock) };
            businesses.set(values.id, business);
            return business;
        },
        async deleteBusiness(id) {
            const existed = businesses.delete(id);
            for (const key of [...shopRows.keys()]) if (key.startsWith(`${id}/`)) shopRows.delete(key);
            for (const key of [...offerRows.keys()]) if (key.startsWith(`${id}/`)) offerRows.delete(key);
            return existed;
        },
        async saveShop(shop) { shopRows.set(`${shop.businessId}/${shop.id}`, shop); },
        async deleteShop(businessId, shopId) {
            for (const key of [...offerRows.keys()]) if (key.startsWith(`${businessId}/${shopId}/`)) offerRows.delete(key);
            return shopRows.delete(`${businessId}/${shopId}`);
        },
        async saveOffer(offer) { offerRows.set(`${offer.businessId}/${offer.shopId}/${offer.id}`, offer); },
        async audit(draft: AuditDraft) {
            const entry: HmpBusinessAuditEntry = { id: nextAuditId++, businessId: draft.businessId, shopId: draft.shopId ?? null, offerId: draft.offerId ?? null, action: draft.action, actorCharacterId: draft.actorCharacterId ?? null, before: draft.before ?? null, after: draft.after ?? null, reason: draft.reason || "", createdAt: new Date(clock) };
            audits.push(entry);
            return entry;
        },
        async history(businessId, limit) { return audits.filter((entry) => entry.businessId === businessId).slice(-limit).reverse(); },
    };

    const registrations = new Map<string, HmpShopDefinition<Player>>();
    const currencies = new Map<string, HmpShopCurrencyProvider<Player>>();
    const stocks = new Map<string, number>();
    let failAdjust = 0;
    const shops = {
        shops: {
            register(definition: HmpShopDefinition<Player>) {
                registrations.set(definition.id, definition);
                return () => registrations.get(definition.id) === definition && registrations.delete(definition.id);
            },
        },
        currencies: {
            register(provider: HmpShopCurrencyProvider<Player>) {
                currencies.set(provider.id, provider);
                return () => currencies.get(provider.id) === provider && currencies.delete(provider.id);
            },
            get: (id: string) => currencies.get(id) || null,
        },
        stock: {
            async get(shopId: string, offerId: string) { return stocks.get(`${shopId}:${offerId}`) ?? null; },
            async set(shopId: string, offerId: string, quantity: number) { stocks.set(`${shopId}:${offerId}`, quantity); return quantity; },
            async adjust(shopId: string, offerId: string, delta: number) {
                if (failAdjust > 0) { failAdjust--; throw new Error("shelf is unavailable"); }
                const key = `${shopId}:${offerId}`;
                const next = (stocks.get(key) ?? 0) + delta;
                if (next < 0) throw Object.assign(new Error("shop stock is unavailable or would become negative"), { code: "HMP_SHOP_STOCK" });
                stocks.set(key, next);
                return next;
            },
        },
    };

    const balances = new Map<string, number>([["personal:12", 100], ["personal:13", 0], ["personal:14", 50], ["org:pippins", 200], ["org:treasury", 0]]);
    const transfers = new Map<string, { from: string; to: string; amount: number }>();
    const organizations = new Map<string, { id: string; currency: string }>([["pippins", { id: "pippins", currency: "galleons" }], ["treasury", { id: "treasury", currency: "galleons" }]]);
    const accountFor = (key: string, currency = "galleons") => ({ id: [...balances.keys()].indexOf(key) + 1, number: key, type: key.startsWith("org:") ? "organization" : "personal", characterId: null, organizationId: null, label: key, currency, balance: balances.get(key) ?? 0, status: "active", createdAt: new Date(0), updatedAt: new Date(0), key });
    const banking = {
        accounts: {
            async personal(target: Player | number, currency = "galleons") { return accountFor(`personal:${characterOf(target)}`, currency); },
            async organization(id: string) { return organizations.has(id) ? accountFor(`org:${id}`, organizations.get(id)!.currency) : null; },
        },
        organizations: { get: (id: string) => organizations.get(id) || null, register(definition: { id: string; currency?: string }) { organizations.set(definition.id, { id: definition.id, currency: definition.currency || "galleons" }); return () => organizations.delete(definition.id); } },
        currencies: { get: (id: string) => id === "galleons" ? { id, resource: "hmp-banking", label: "Galleons", symbol: "Ⓖ" } : null },
        transactions: {
            async transfer(from: { key: string }, to: { key: string }, amount: number, options: { reference?: string }) {
                const reference = options.reference || `auto:${transfers.size}`;
                if (transfers.has(reference)) return { status: "completed", reference };
                if ((balances.get(from.key) ?? 0) < amount) throw Object.assign(new Error("Insufficient funds."), { code: "HMP_BANK_FUNDS" });
                balances.set(from.key, (balances.get(from.key) ?? 0) - amount);
                balances.set(to.key, (balances.get(to.key) ?? 0) + amount);
                transfers.set(reference, { from: from.key, to: to.key, amount });
                return { status: "completed", reference };
            },
        },
    };

    const counts = new Map<string, number>([["native:wiggenweld_potion", 3], ["native:edurus_potion", 0]]);
    const failAdds = new Map<string, number>();
    const inventory = {
        items: { get: (name: string) => ({
            "native:wiggenweld_potion": { name, label: "Wiggenweld Potion" },
            "native:edurus_potion": { name, label: "Edurus Potion", referenceValue: 30 },
            "native:horklump_juice": { name, label: "Horklump Juice" },
        } as Record<string, unknown>)[name] || null },
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

    const interactions = new Map<string, { id: string; handler?: (context: { player: Player }) => unknown }>();
    const notifications: Array<{ description: string; tone?: string }> = [];
    const menus: Array<{ title: string; options: Array<{ id: string }> }> = [];
    const inputs: unknown[] = [];
    const alerts: unknown[] = [];
    const contextChoices: Array<string | null> = [];
    const inputChoices: Array<Record<string, string | number | boolean> | null> = [];
    const alertChoices: Array<"confirm" | "cancel" | null> = [];
    const emitted: Array<{ name: string; payload: unknown }> = [];

    const service = createBusinessService({
        repository,
        core: { characters: { active: (player: Player) => ({ id: characterOf(player) }) }, groups: { has: async (player: Player, key: string) => key === "job:pippins" && staff.has(characterOf(player)) } } as never,
        inventory: inventory as never,
        interact: { register(definition: { id: string }) { interactions.set(definition.id, definition); return () => interactions.delete(definition.id); } } as never,
        ui: {
            notify(_player: Player, value: { description: string }) { notifications.push(value); return true; },
            async context(_player: Player, value: { title: string; options: Array<{ id: string }> }) { menus.push(value); return contextChoices.shift() ?? null; },
            async input(_player: Player, value: unknown) { inputs.push(value); return inputChoices.shift() ?? null; },
            async alert(_player: Player, value: unknown) { alerts.push(value); return alertChoices.shift() ?? null; },
            close: () => true,
        } as never,
        banking: banking as never,
        shops: shops as never,
        jobs: {
            jobs: { get: (id: string) => jobRegistered && id === "pippins" ? JOB : null },
            permissions: { has: async (target: Player | number, permission: string, jobId: string) => permission === "shop.manage" && jobId === "pippins" && managers.has(typeof target === "number" ? target : characterOf(target)) },
            duty: { list: (jobId?: string) => duties.filter((duty) => !jobId || duty.jobId === jobId), toggle: async (player: Player, jobId: string) => ({ playerId: player.id, jobId }) },
        } as never,
        lib: {
            player: { byId: (id: number | string) => players.get(Number(id)) || null },
            position: { within: (left: { position?: { x: number; y: number; z: number }; x?: number }, right: { x: number; y: number; z: number }, radius: number) => {
                const point = "position" in left && left.position ? left.position : left as { x: number; y: number; z: number };
                return Math.hypot(point.x - right.x, point.y - right.y, point.z - right.z) <= radius;
            } },
        } as never,
        events: { emit(name, payload) { emitted.push({ name, payload }); } },
        logger: { info: () => true, warn: () => true, error: () => true },
        migrations: [],
        config: { prices: { floor: 1, ceiling: 100000, ceilings: {}, buybacks: { enabled: overrides.buybacks === true, maxRatio: 0.5, referenceValues: { "native:wiggenweld_potion": 20 } } }, houseCut: { percent: overrides.houseCutPercent ?? 0, organizationId: "treasury", label: "Treasury", currency: "galleons" } },
        now: () => clock,
        today: () => "2026-09-05",
    });

    return {
        service, josh, clerk, customer, audits, registrations, currencies, stocks, balances, transfers, counts, interactions, notifications, menus, inputs, alerts, emitted,
        contextChoices, inputChoices, alertChoices, duties,
        failAdd(name: string, times = 1) { failAdds.set(name, times); },
        failAdjustOnce() { failAdjust = 1; },
        registerJob(value: boolean) { jobRegistered = value; },
        clockIn(player: Player) { duties.push({ playerId: player.id, characterId: characterOf(player), jobId: "pippins", since: new Date(clock) }); service.onDuty({ player, job: JOB, onDuty: true }); },
        clockOut(player: Player) { const index = duties.findIndex((duty) => duty.playerId === player.id); if (index >= 0) duties.splice(index, 1); service.onDuty({ player, job: JOB, onDuty: false }); },
        advance(ms: number) { clock += ms; },
    };
}

async function pippins(state: ReturnType<typeof setup>, staffing: "always" | "staffed" | "kiosk" = "always") {
    await state.service.start();
    await state.service.businesses.create({ id: "pippins", jobId: "pippins", label: "J. Pippin's Potions" });
    await state.service.shops.add("pippins", { id: "hogsmeade", label: "Hogsmeade counter", position: COUNTER, areaId: "Overland", radius: 300, staffRadius: 500, vendor: { characterId: "PercivalPippin", yaw: 30 }, staffing, dutyPoint: { x: 1100, y: 2000, z: 300 } });
    await state.service.offers.set("pippins", "hogsmeade", { id: "wiggenweld", item: "native:wiggenweld_potion", buyPrice: 25, buybackRatio: 0.4, maxQuantity: 6, stock: 5 });
}

const key = shopKey("pippins", "hogsmeade");

test("normalizes businesses, counters and offers within price bounds", () => {
    assert.deepStrictEqual(normalizeBusiness({ id: "pippins", jobId: "pippins" }), { id: "pippins", jobId: "pippins", label: "pippins", currency: "galleons", enabled: true });
    assert.throws(() => normalizeBusiness({ id: "a-very-long-business-identifier", jobId: "pippins" }), /business id is invalid/);
    const shop = normalizeShop("pippins", { id: "stall", position: COUNTER, staffing: "STAFFED" as never, vendor: { characterId: "PercivalPippin" } });
    assert.strictEqual(shop.staffing, "staffed");
    assert.strictEqual(shop.staffRadius, 1000);
    assert.strictEqual(shop.dutyPoint, null);
    assert.deepStrictEqual(shop.vendor, { characterId: "PercivalPippin", yaw: undefined, label: undefined });
    assert.throws(() => normalizeShop("pippins", { id: "stall", position: { x: Number.NaN, y: 0, z: 0 } }), /finite position/);
    assert.throws(() => normalizeShop("pippins", { id: "stall", position: COUNTER, staffing: "sometimes" as never }), /staffing policy/);
    const bounds = { floor: 1, ceiling: 500 };
    const { offer, stock } = normalizeOffer("pippins", "stall", { id: "wiggenweld", item: "native:wiggenweld_potion", buyPrice: 25, stock: 12 }, bounds);
    assert.strictEqual(offer.sellPrice, undefined);
    assert.strictEqual(stock, 12);
    assert.throws(() => normalizeOffer("pippins", "stall", { id: "free", item: "native:wiggenweld_potion", buyPrice: 0 }, bounds), /between 1 and 500/);
    assert.throws(() => normalizeOffer("pippins", "stall", { id: "dear", item: "native:wiggenweld_potion", buyPrice: 501 }, bounds), /between 1 and 500/);
    assert.throws(() => normalizeOffer("pippins", "stall", { id: "none", item: "native:wiggenweld_potion" }, bounds), /buy price or a sell price/);
    assert.throws(() => normalizeOffer("pippins", "stall", { id: "both", item: "native:wiggenweld_potion", buyPrice: 5, sellPrice: 3 }, bounds), /beside a buy price/);
    assert.throws(() => normalizeOffer("pippins", "stall", { id: "ratio", item: "native:wiggenweld_potion", buyPrice: 5, buybackRatio: 1.5 }, bounds), /between 0 and 1/);
    assert.strictEqual(normalizeOffer("pippins", "stall", { id: "ratio", item: "native:wiggenweld_potion", buyPrice: 5, buybackRatio: 0.3333 }, bounds).offer.buybackRatio, 0.333);
    assert.strictEqual(normalizeOffer("pippins", "stall", { id: "pawn", item: "native:wiggenweld_potion", sellPrice: 3 }, bounds).offer.buyPrice, undefined);
    assert.strictEqual(shopKey("pippins", "stall"), "business:pippins:stall");
    assert.ok(compactReference("bizd", "x".repeat(200)).length <= 96);
    assert.strictEqual(compactReference("bizd", "shop:7:abc"), "bizd:shop:7:abc");
});

test("normalizes data-declared businesses and rejects malformed entries", () => {
    const config = normalizeConfig({
        prices: { floor: 1, ceiling: 5000, ceilings: { galleons: 900 } },
        houseCut: { percent: 5 },
        businesses: [{ id: "pippins", jobId: "pippins", shops: [{ id: "hogsmeade", position: COUNTER, offers: [{ id: "wiggenweld", item: "native:wiggenweld_potion", buyPrice: 25, stock: 12 }] }] }],
    });
    assert.strictEqual(config.prices.ceilings.galleons, 900);
    assert.strictEqual(config.houseCut.percent, 5);
    assert.strictEqual(config.houseCut.organizationId, "treasury");
    assert.strictEqual(config.commands.command, "business");
    assert.deepStrictEqual(config.prices.buybacks, { enabled: false, maxRatio: 0.5, referenceValues: {} });
    assert.deepStrictEqual(normalizeConfig({ prices: { buybacks: { enabled: true, maxRatio: 0.25, referenceValues: { "native:wiggenweld_potion": 20.7 } } } }).prices.buybacks, { enabled: true, maxRatio: 0.25, referenceValues: { "native:wiggenweld_potion": 20 } });
    assert.throws(() => normalizeConfig({ prices: { buybacks: { maxRatio: 2 } } }), /between 0 and 1/);
    assert.throws(() => normalizeConfig({ prices: { buybacks: { referenceValues: { potion: 0 } } } }), /positive number/);
    assert.deepStrictEqual(config.commands.adminGroups, [{ key: "admin", minimumGrade: 1 }]);
    assert.strictEqual(config.businesses[0].shops[0].offers[0].stock, 12);
    assert.deepStrictEqual(normalizeConfig({}).businesses, []);
    assert.throws(() => normalizeConfig({ businesses: {} }), /must be an array/);
    assert.throws(() => normalizeConfig({ businesses: [{ id: "pippins", jobId: "pippins", shops: [{ id: "a", position: COUNTER, offers: [{ id: "w", item: "x", buyPrice: 5000 }] }] }], prices: { ceilings: { galleons: 900 } } }), /between 1 and 900/);
    assert.throws(() => normalizeConfig({ businesses: [{ id: "pippins", jobId: "pippins" }, { id: "pippins", jobId: "pippins" }] }), /twice/);
});

test("registers counters with hmp-shops under the business id, bound to the job group and till", async () => {
    const state = setup();
    await pippins(state);
    const registered = state.registrations.get(key)!;
    assert.ok(registered, "counter is registered with hmp-shops");
    assert.strictEqual(registered.resource, "hmp-business");
    assert.strictEqual(registered.currency, "business:pippins");
    assert.strictEqual(registered.offers[0].stock, 0);
    assert.strictEqual(registered.offers[0].buyPrice, 25);
    assert.strictEqual(state.stocks.get(`${key}:wiggenweld`), 5);
    assert.deepStrictEqual(registered.interaction?.character, { characterId: "PercivalPippin", yaw: 30, label: undefined });
    assert.ok(state.currencies.has("business:pippins"));
    assert.ok(state.interactions.has("business:pippins:hogsmeade:duty"));
    assert.strictEqual(registered.offers[0].sellPrice, undefined, "buybacks are off by default");
    assert.strictEqual(registered.offers[0].requirements, undefined);
    assert.strictEqual(state.service.offers.buybackPrice("pippins", "hogsmeade", "wiggenweld"), null);
    assert.strictEqual(state.service.shops.shopId("pippins", "hogsmeade"), key);
    assert.deepStrictEqual(state.audits.map((entry) => entry.action), ["business.create", "shop.add", "offer.add"]);
    assert.strictEqual(state.service.status().liveShops, 1);
});

test("waits for the job to register before publishing a counter", async () => {
    const state = setup({ jobRegistered: false });
    await pippins(state);
    assert.strictEqual(state.registrations.has(key), false);
    assert.strictEqual(state.service.status().liveShops, 0);
    state.registerJob(true);
    state.service.onResourceStart("hmp-hogsmeade");
    assert.strictEqual(state.registrations.has(key), true);
    assert.strictEqual(state.service.status().liveShops, 1);
});

test("staffed counters refuse customers and swap the vendor body for on-duty staff", async () => {
    const state = setup();
    await pippins(state, "staffed");
    const closed = state.registrations.get(key)!;
    assert.ok(closed.interaction?.character, "vendor body stands in while nobody is on duty");
    assert.strictEqual(await closed.requirements!.allow!({ player: state.customer, character: { id: 14 }, shop: closed, offer: null, direction: null }), "Nobody is at the counter.");
    assert.strictEqual(state.service.shops.isStaffed("pippins", "hogsmeade"), false);

    state.clockIn(state.clerk);
    const open = state.registrations.get(key)!;
    assert.notStrictEqual(open, closed, "duty change re-registers the counter");
    assert.strictEqual(open.interaction?.character, undefined);
    assert.strictEqual(await open.requirements!.allow!({ player: state.customer, character: { id: 14 }, shop: open, offer: null, direction: null }), true);
    assert.strictEqual(state.service.shops.isStaffed("pippins", "hogsmeade"), true);

    state.clockOut(state.clerk);
    assert.ok(state.registrations.get(key)!.interaction?.character, "vendor body returns when staff clock out");

    state.clockIn(state.josh);
    assert.ok(state.registrations.get(key)!.interaction?.character, "an on-duty employee far from the counter does not staff it");
});

test("enforces shop.manage, administrator-only placement and price bounds, and audits price changes", async () => {
    const state = setup();
    await pippins(state);
    await assert.rejects(state.service.offers.setPrices("pippins", "hogsmeade", "wiggenweld", { buyPrice: 30 }, { actor: state.clerk }), /cannot manage/);
    await assert.rejects(state.service.offers.setPrices("pippins", "hogsmeade", "wiggenweld", { buyPrice: 0 }, { actor: state.josh }), /between 1 and 100000/);
    const updated = await state.service.offers.setPrices("pippins", "hogsmeade", "wiggenweld", { buyPrice: 30 }, { actor: state.josh, reason: "Winter prices" });
    assert.strictEqual(updated.buyPrice, 30);
    assert.strictEqual(updated.sellPrice, undefined);
    const entry = state.audits.at(-1)!;
    assert.strictEqual(entry.action, "offer.price");
    assert.strictEqual(entry.actorCharacterId, 12);
    assert.strictEqual(entry.reason, "Winter prices");
    assert.strictEqual((entry.before as { buyPrice: number }).buyPrice, 25);
    assert.strictEqual(state.registrations.get(key)!.offers[0].buyPrice, 30);
    assert.strictEqual(state.registrations.get(key)!.offers[0].requirements, undefined);

    await assert.rejects(state.service.shops.add("pippins", { id: "stall", position: COUNTER }, { actor: state.josh }), /administrator/);
    await assert.rejects(state.service.shops.update("pippins", "hogsmeade", { position: { x: 0, y: 0, z: 0 } }, { actor: state.josh }), /Moving a counter needs an administrator/);
    await assert.rejects(state.service.offers.set("pippins", "hogsmeade", { id: "edurus", item: "native:edurus_potion", buyPrice: 40, unlimited: true }, { actor: state.josh }), /unlimited/);
    await assert.rejects(state.service.offers.set("pippins", "hogsmeade", { id: "brooms", item: "native:broom", buyPrice: 40 }, { actor: state.josh }), /does not exist/);
    await assert.rejects(state.service.stock.set("pippins", "hogsmeade", "wiggenweld", 99, { actor: state.josh }), /administrator/);
    await assert.rejects(state.service.businesses.create({ id: "rival", jobId: "pippins" }, { actor: state.josh }), /administrator/);
    const admin = await state.service.shops.add("pippins", { id: "stall", position: { x: 0, y: 0, z: 0 } }, { actor: state.josh, admin: true });
    assert.strictEqual(state.audits.at(-1)!.actorCharacterId, 12);
    assert.strictEqual(admin.id, "stall");
    const closed = await state.service.shops.update("pippins", "hogsmeade", { enabled: false }, { actor: state.josh });
    assert.strictEqual(closed.enabled, false);
    assert.strictEqual(state.audits.at(-1)!.action, "shop.close");
    assert.strictEqual(state.registrations.has(key), false);
    await state.service.shops.update("pippins", "hogsmeade", { enabled: true, staffing: "kiosk" }, { actor: state.josh });
    assert.strictEqual(state.registrations.get(key)!.interaction?.character, undefined, "kiosks never show a vendor body");
    assert.deepStrictEqual((await state.service.businesses.managed(state.josh)).map((business) => business.id), ["pippins"]);
    assert.deepStrictEqual(await state.service.businesses.managed(state.clerk), []);
});

test("restocks from inventory and compensates a failed shelf write", async () => {
    const state = setup();
    await pippins(state);
    assert.strictEqual(await state.service.stock.restock(state.josh, "pippins", "hogsmeade", "wiggenweld", 2), 7);
    assert.strictEqual(state.counts.get("native:wiggenweld_potion"), 1);
    assert.strictEqual(state.audits.at(-1)!.action, "stock.restock");
    await assert.rejects(state.service.stock.restock(state.josh, "pippins", "hogsmeade", "wiggenweld", 5), /do not carry/);
    await assert.rejects(state.service.stock.restock(state.clerk, "pippins", "hogsmeade", "wiggenweld", 1), /cannot manage/);
    state.failAdjustOnce();
    await assert.rejects(state.service.stock.restock(state.josh, "pippins", "hogsmeade", "wiggenweld", 1), /shelf is unavailable/);
    assert.strictEqual(state.counts.get("native:wiggenweld_potion"), 1, "items return to the inventory when the shelf write fails");
    assert.strictEqual(state.stocks.get(`${key}:wiggenweld`), 7);
});

test("withdraws capped at current stock and compensates a failed inventory grant", async () => {
    const state = setup();
    await pippins(state);
    assert.strictEqual(await state.service.stock.withdraw(state.josh, "pippins", "hogsmeade", "wiggenweld", 10), 0);
    assert.strictEqual(state.counts.get("native:wiggenweld_potion"), 8);
    await assert.rejects(state.service.stock.withdraw(state.josh, "pippins", "hogsmeade", "wiggenweld", 1), /holds no/);
    await state.service.stock.set("pippins", "hogsmeade", "wiggenweld", 4);
    state.failAdd("native:wiggenweld_potion");
    await assert.rejects(state.service.stock.withdraw(state.josh, "pippins", "hogsmeade", "wiggenweld", 2), /failed to add/);
    assert.strictEqual(state.stocks.get(`${key}:wiggenweld`), 4, "stock returns to the shelf when the grant fails");
});

test("transfers stock between counters of one business", async () => {
    const state = setup();
    await pippins(state);
    await state.service.shops.add("pippins", { id: "stall", label: "Courtyard stall", position: { x: 5000, y: 5000, z: 300 } });
    await state.service.offers.set("pippins", "stall", { id: "wiggenweld", item: "native:wiggenweld_potion", buyPrice: 28, stock: 0 }, { actor: state.josh });
    assert.deepStrictEqual(await state.service.stock.transfer("pippins", "hogsmeade", "stall", "wiggenweld", 3, { actor: state.josh }), { from: 2, to: 3 });
    await assert.rejects(state.service.stock.transfer("pippins", "hogsmeade", "stall", "wiggenweld", 5, { actor: state.josh }), /negative/);
    assert.strictEqual(state.stocks.get(`${key}:wiggenweld`), 2);
    assert.strictEqual(state.stocks.get(`${shopKey("pippins", "stall")}:wiggenweld`), 3);
    await assert.rejects(state.service.stock.transfer("pippins", "hogsmeade", "hogsmeade", "wiggenweld", 1), /two different counters/);
    await assert.rejects(state.service.stock.transfer("pippins", "hogsmeade", "stall", "edurus", 1), /no offer/);
});

test("the till moves money between the buyer and the organization account", async () => {
    const state = setup();
    await pippins(state);
    const till = state.currencies.get("business:pippins")!;
    assert.strictEqual(till.label, "Galleons");
    assert.strictEqual(await till.balance(state.customer), 50);
    const context = { player: state.customer, characterId: 14, shop: state.registrations.get(key)!, offer: state.registrations.get(key)!.offers[0], direction: "buy" as const, reference: "shop:9:abc:wiggenweld:buy" };
    assert.strictEqual(await till.debit(state.customer, 30, context), true);
    assert.strictEqual(state.balances.get("personal:14"), 20);
    assert.strictEqual(state.balances.get("org:pippins"), 230);
    assert.strictEqual(await till.debit(state.customer, 30, { ...context, reference: "shop:9:def:wiggenweld:buy" }), false, "insufficient funds refuse without throwing");
    assert.strictEqual(await till.credit(state.customer, 8, { ...context, direction: "sell", reference: "shop:9:ghi:wiggenweld:sell" }), true);
    assert.strictEqual(state.balances.get("personal:14"), 28);
    assert.strictEqual(state.balances.get("org:pippins"), 222);
    state.balances.set("org:pippins", 0);
    assert.strictEqual(await till.credit(state.customer, 8, { ...context, direction: "sell", reference: "shop:9:jkl:wiggenweld:sell" }), false, "an empty till cannot pay staff");
    assert.strictEqual([...state.transfers.keys()].every((reference) => reference.length <= 96), true);
});

test("takes the house cut once per purchase reference and keeps the books", async () => {
    const state = setup({ houseCutPercent: 10 });
    await pippins(state);
    const shop = { id: key, resource: "hmp-business" };
    await state.service.onPurchased({ player: state.customer, shop, transaction: { reference: "shop:9:one", totalPrice: 30, direction: "buy" } });
    await state.service.onPurchased({ player: state.customer, shop, transaction: { reference: "shop:9:one", totalPrice: 30, direction: "buy" } });
    await state.service.onPurchased({ player: state.customer, shop, transaction: { reference: "shop:9:two", totalPrice: 25, direction: "buy" } });
    await state.service.onPurchased({ player: state.customer, shop: { id: "pippins", resource: "hmp-shops" }, transaction: { reference: "shop:9:other", totalPrice: 100, direction: "buy" } });
    state.service.onSold({ player: state.clerk, shop, transaction: { reference: "shop:8:sell", totalPrice: 8, direction: "sell" } });
    assert.strictEqual(state.balances.get("org:treasury"), 5, "3 + 2 galleons of cut, the replayed reference moves nothing");
    assert.strictEqual(state.balances.get("org:pippins"), 195);
    const books = await state.service.books.summary("pippins", { actor: state.josh });
    assert.strictEqual(books.balance, 195);
    assert.strictEqual(books.day, "2026-09-05");
    assert.deepStrictEqual(books.shops, [{ shopId: "hogsmeade", label: "Hogsmeade counter", purchases: 3, revenue: 85, buybacks: 1, spent: 8 }]);
    await assert.rejects(state.service.books.summary("pippins", { actor: state.clerk }), /cannot manage/);
});

test("retires offers without losing stock and closes a counter that has nothing left to sell", async () => {
    const state = setup();
    await pippins(state);
    const retired = await state.service.offers.retire("pippins", "hogsmeade", "wiggenweld", { actor: state.josh });
    assert.strictEqual(retired.enabled, false);
    assert.strictEqual(state.registrations.has(key), false, "a counter without offers is withdrawn from hmp-shops");
    assert.strictEqual(state.stocks.get(`${key}:wiggenweld`), 5);
    assert.deepStrictEqual(state.service.offers.list("pippins", "hogsmeade").length, 0);
    assert.deepStrictEqual(state.service.offers.list("pippins", "hogsmeade", true).length, 1);
    await state.service.offers.restore("pippins", "hogsmeade", "wiggenweld", { actor: state.josh });
    assert.strictEqual(state.registrations.get(key)!.offers.length, 1);
    assert.deepStrictEqual(state.audits.slice(-2).map((entry) => entry.action), ["offer.retire", "offer.restore"]);
});

test("drives the management menu to set prices and restock", async () => {
    const state = setup();
    await pippins(state);
    state.contextChoices.push("prices", "wiggenweld");
    state.inputChoices.push({ buyPrice: 32, reason: "" });
    const updated = await state.service.ui.manage(state.josh) as HmpBusinessOffer;
    assert.strictEqual(updated.buyPrice, 32);
    assert.strictEqual(updated.sellPrice, undefined);
    assert.strictEqual(state.menus[0].title, "J. Pippin's Potions");
    assert.ok(state.notifications.some((entry) => entry.description.includes("sells for Ⓖ32")));

    state.contextChoices.push("restock", "wiggenweld");
    state.inputChoices.push({ quantity: 3 });
    assert.strictEqual(await state.service.ui.manage(state.josh, "pippins"), 8);
    assert.strictEqual(state.counts.get("native:wiggenweld_potion"), 0);

    assert.strictEqual(await state.service.ui.manage(state.clerk), null);
    assert.ok(state.notifications.some((entry) => entry.description === "You do not manage any business."));
});

test("seeds configured businesses once and tears everything down on stop", async () => {
    const state = setup();
    const seed = [{ id: "pippins", jobId: "pippins", label: "J. Pippin's Potions", shops: [{ id: "hogsmeade", position: COUNTER, offers: [{ id: "wiggenweld", item: "native:wiggenweld_potion", buyPrice: 25, stock: 12 }] }] }];
    assert.strictEqual(await state.service.seed(seed), 1);
    assert.strictEqual(await state.service.seed(seed), 0);
    assert.strictEqual(state.stocks.get(`${key}:wiggenweld`), 12);
    assert.strictEqual(state.registrations.has(key), true);
    assert.strictEqual(await state.service.businesses.sync(), 1);
    await state.service.businesses.remove("pippins");
    assert.strictEqual(state.registrations.has(key), false);
    assert.strictEqual(state.currencies.has("business:pippins"), false);
    assert.strictEqual(state.service.businesses.get("pippins"), null);
    await state.service.seed(seed);
    await state.service.stop();
    assert.strictEqual(state.registrations.size, 0);
    assert.strictEqual(state.currencies.size, 0);
    assert.strictEqual(state.interactions.size, 0);
    assert.strictEqual(state.service.status().state, "stopped");
});

test("keeps counters buy-only while buybacks are disabled", async () => {
    const state = setup();
    await pippins(state);
    await assert.rejects(state.service.offers.setPrices("pippins", "hogsmeade", "wiggenweld", { buybackRatio: 0.3 }, { actor: state.josh }), /disabled/);
    await state.service.offers.set("pippins", "hogsmeade", { id: "scraps", item: "native:horklump_juice", sellPrice: 3 });
    const registered = state.registrations.get(key)!;
    assert.deepStrictEqual(registered.offers.map((offer) => offer.id), ["wiggenweld"], "a sell-only offer is not published while buybacks are off");
    assert.strictEqual(registered.offers[0].sellPrice, undefined);
    assert.strictEqual(state.service.offers.buybackPrice("pippins", "hogsmeade", "scraps"), null);
    assert.strictEqual(state.service.offers.get("pippins", "hogsmeade", "wiggenweld")?.buybackRatio, 0.4, "the seeded share is kept for when buybacks are enabled");
});

test("derives buyback prices from reference values and keeps managers off their own counters", async () => {
    const state = setup({ buybacks: true });
    await pippins(state);
    const allow = (player: Player, direction: "buy" | "sell", offerId = "wiggenweld") => {
        const shop = state.registrations.get(key)!;
        const offer = shop.offers.find((entry) => entry.id === offerId)!;
        return offer.requirements!.allow!({ player, character: { id: 1 }, shop, offer, direction });
    };
    assert.strictEqual(state.registrations.get(key)!.offers[0].sellPrice, 8, "0.4 of the configured reference value 20");
    assert.strictEqual(state.service.offers.buybackPrice("pippins", "hogsmeade", "wiggenweld"), 8);
    assert.strictEqual(await allow(state.customer, "sell"), "Only staff may sell to this counter.");
    assert.strictEqual(await allow(state.josh, "sell"), "Managers cannot sell to their own counters.");
    assert.strictEqual(await allow(state.clerk, "sell"), true);
    assert.strictEqual(await allow(state.customer, "buy"), true);

    await assert.rejects(state.service.offers.setPrices("pippins", "hogsmeade", "wiggenweld", { buybackRatio: 0.6 }, { actor: state.josh }), /may not exceed 0.5/);
    await assert.rejects(state.service.offers.setPrices("pippins", "hogsmeade", "wiggenweld", { sellPrice: 90 }, { actor: state.josh }), /beside a buy price/);
    const raised = await state.service.offers.setPrices("pippins", "hogsmeade", "wiggenweld", { buybackRatio: 0.5 }, { actor: state.josh });
    assert.strictEqual(raised.buybackRatio, 0.5);
    assert.strictEqual(state.registrations.get(key)!.offers[0].sellPrice, 10);
    assert.strictEqual(state.audits.at(-1)!.action, "offer.price");
    const dropped = await state.service.offers.setPrices("pippins", "hogsmeade", "wiggenweld", { buybackRatio: null }, { actor: state.josh });
    assert.strictEqual(dropped.buybackRatio, null);
    assert.strictEqual(state.registrations.get(key)!.offers[0].sellPrice, undefined);

    await state.service.offers.set("pippins", "hogsmeade", { id: "edurus", item: "native:edurus_potion", buyPrice: 40, buybackRatio: 0.5 }, { actor: state.josh });
    assert.strictEqual(state.service.offers.referenceValue("native:edurus_potion"), 30, "item definitions supply reference values when the config has none");
    assert.strictEqual(state.registrations.get(key)!.offers.find((offer) => offer.id === "edurus")!.sellPrice, 15);
    await state.service.offers.set("pippins", "hogsmeade", { id: "horklump", item: "native:horklump_juice", buyPrice: 5, buybackRatio: 0.5 }, { actor: state.josh });
    assert.strictEqual(state.service.offers.referenceValue("native:horklump_juice"), null);
    assert.strictEqual(state.registrations.get(key)!.offers.find((offer) => offer.id === "horklump")!.sellPrice, undefined, "no reference value means no buyback");

    await state.service.offers.set("pippins", "hogsmeade", { id: "scraps", item: "native:horklump_juice", sellPrice: 3 });
    const pawn = state.registrations.get(key)!.offers.find((offer) => offer.id === "scraps")!;
    assert.strictEqual(pawn.buyPrice, undefined);
    assert.strictEqual(pawn.sellPrice, 3, "administrator-set sell-only offers keep their raw price");
    assert.strictEqual(await allow(state.josh, "sell", "scraps"), "Managers cannot sell to their own counters.");

    state.contextChoices.push("prices", "wiggenweld");
    state.inputChoices.push({ buyPrice: 25, buybackRatio: 0.25, reason: "" });
    const menu = await state.service.ui.manage(state.josh, "pippins") as HmpBusinessOffer;
    assert.strictEqual(menu.buybackRatio, 0.25);
    assert.ok(state.inputs.some((dialog) => JSON.stringify(dialog).includes("Buyback share")));
    assert.ok(state.notifications.some((entry) => entry.description.includes("buys back at Ⓖ5")));
});
