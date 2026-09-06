import normalizeModule = require("../shared/normalize");
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpBusinessOfferInput, HmpBusinessShopInput } from "../types";
import type { AdminGroup, BusinessConfig, PriceConfig, SeedBusiness } from "./internal";

const { clean, id, integer, normalizeBusiness, normalizeShop, normalizeOffer } = normalizeModule;

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function boundsFor(prices: PriceConfig, currency: string) {
    return { floor: prices.floor, ceiling: prices.ceilings[currency] ?? prices.ceiling };
}

function normalizePrices(raw: unknown): PriceConfig {
    const value = isObject(raw) ? raw : {};
    const floor = integer(value.floor, 1, 0, 2147483647);
    const ceiling = integer(value.ceiling, 1_000_000, floor, 2147483647);
    const ceilings: Record<string, number> = {};
    if (value.ceilings !== undefined) {
        if (!isObject(value.ceilings)) throw new TypeError("hmp-business configuration 'prices.ceilings' must be an object");
        for (const [currency, limit] of Object.entries(value.ceilings)) ceilings[id(currency, "price ceiling currency")] = integer(limit, ceiling, floor, 2147483647);
    }
    const buybacksRaw = isObject(value.buybacks) ? value.buybacks : {};
    const maxRatioValue = Number(buybacksRaw.maxRatio ?? 0.5);
    if (!Number.isFinite(maxRatioValue) || maxRatioValue < 0 || maxRatioValue > 1) throw new TypeError("hmp-business configuration 'prices.buybacks.maxRatio' must be between 0 and 1");
    const referenceValues: Record<string, number> = {};
    if (buybacksRaw.referenceValues !== undefined) {
        if (!isObject(buybacksRaw.referenceValues)) throw new TypeError("hmp-business configuration 'prices.buybacks.referenceValues' must be an object");
        for (const [item, worth] of Object.entries(buybacksRaw.referenceValues)) {
            const amount = Number(worth);
            if (!Number.isFinite(amount) || amount < 1) throw new TypeError(`hmp-business configuration reference value for '${item}' must be a positive number`);
            referenceValues[id(item, "reference value item")] = Math.trunc(amount);
        }
    }
    const buybacks = Object.freeze({ enabled: buybacksRaw.enabled === true, maxRatio: Math.round(maxRatioValue * 1000) / 1000, referenceValues: Object.freeze(referenceValues) });
    return Object.freeze({ floor, ceiling, ceilings: Object.freeze(ceilings), buybacks });
}

function normalizeSeed(raw: unknown, index: number, prices: PriceConfig): SeedBusiness {
    if (!isObject(raw)) throw new TypeError(`hmp-business configuration businesses[${index}] must be an object`);
    const business = normalizeBusiness(raw as never);
    const bounds = boundsFor(prices, business.currency);
    const rawShops = raw.shops === undefined ? [] : raw.shops;
    if (!Array.isArray(rawShops)) throw new TypeError(`hmp-business configuration business '${business.id}' shops must be an array`);
    const seenShops = new Set<string>();
    const shops = rawShops.map((entry) => {
        if (!isObject(entry)) throw new TypeError(`hmp-business configuration business '${business.id}' has a malformed shop`);
        const shop = normalizeShop(business.id, entry as unknown as HmpBusinessShopInput);
        if (seenShops.has(shop.id)) throw new TypeError(`hmp-business configuration business '${business.id}' declares shop '${shop.id}' twice`);
        seenShops.add(shop.id);
        const rawOffers = entry.offers === undefined ? [] : entry.offers;
        if (!Array.isArray(rawOffers)) throw new TypeError(`hmp-business configuration shop '${shop.id}' offers must be an array`);
        const seenOffers = new Set<string>();
        const offers = rawOffers.map((offerEntry) => {
            const { offer, stock } = normalizeOffer(business.id, shop.id, offerEntry as HmpBusinessOfferInput, bounds);
            if (seenOffers.has(offer.id)) throw new TypeError(`hmp-business configuration shop '${shop.id}' declares offer '${offer.id}' twice`);
            seenOffers.add(offer.id);
            return { ...offer, stock: stock ?? undefined };
        });
        return { ...shop, offers };
    });
    return { ...business, shops };
}

export function normalizeConfig(raw: unknown): BusinessConfig {
    if (!isObject(raw)) throw new TypeError("hmp-business configuration must be an object");
    const prices = normalizePrices(raw.prices);
    const houseCutRaw = isObject(raw.houseCut) ? raw.houseCut : {};
    const houseCut = Object.freeze({
        percent: integer(houseCutRaw.percent, 0, 0, 100),
        organizationId: id(houseCutRaw.organizationId || "treasury", "house cut organization id"),
        label: clean(houseCutRaw.label, 80) || "Treasury",
        currency: id(houseCutRaw.currency || "galleons", "house cut currency"),
    });
    const commandsRaw = isObject(raw.commands) ? raw.commands : {};
    const rawGroups = commandsRaw.adminGroups === undefined ? [{ key: "admin", minimumGrade: 1 }] : commandsRaw.adminGroups;
    if (!Array.isArray(rawGroups)) throw new TypeError("hmp-business configuration 'commands.adminGroups' must be an array");
    const adminGroups: AdminGroup[] = rawGroups.map((entry, index) => {
        if (!isObject(entry)) throw new TypeError(`hmp-business configuration commands.adminGroups[${index}] must be an object`);
        return Object.freeze({ key: id(entry.key, "admin group key"), minimumGrade: integer(entry.minimumGrade, 0, -100000, 100000) });
    });
    const commands = Object.freeze({
        enabled: commandsRaw.enabled !== false,
        command: clean(commandsRaw.command, 32).replace(/^\//, "") || "business",
        adminGroups: Object.freeze(adminGroups) as AdminGroup[],
    });
    const rawBusinesses = raw.businesses === undefined ? [] : raw.businesses;
    if (!Array.isArray(rawBusinesses)) throw new TypeError("hmp-business configuration 'businesses' must be an array");
    const seen = new Set<string>();
    const businesses = rawBusinesses.map((entry, index) => {
        const business = normalizeSeed(entry, index, prices);
        if (seen.has(business.id)) throw new TypeError(`hmp-business configuration declares business '${business.id}' twice`);
        seen.add(business.id);
        return business;
    });
    return { prices, houseCut, commands, businesses };
}

export function loadConfig(Hmp: HmpLibServer, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): BusinessConfig {
    const env = options.env || process.env;
    const loaded = Hmp.config.load<Record<string, unknown>>(env.HMP_BUSINESS_CONFIG || "data/hmp-business.json", {
        cwd: options.cwd || process.cwd(),
        defaults: {},
    });
    return normalizeConfig(loaded);
}

export { boundsFor };
