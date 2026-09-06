import normalizeModule = require("../shared/normalize");
import type { HmpShopCurrencyProvider, HmpShopDefinition, HmpShopOffer } from "../../hmp-shops/types";
import type {
    HmpBusiness,
    HmpBusinessBooks,
    HmpBusinessDefinition,
    HmpBusinessMutationOptions,
    HmpBusinessOffer,
    HmpBusinessOfferInput,
    HmpBusinessShop,
    HmpBusinessShopInput,
    HmpBusinessShopSales,
} from "../types";
import type { AuditDraft, BusinessDependencies, BusinessService, DutyEvent, Player, SeedBusiness, ShopTradeEvent } from "./internal";

const { clean, id: normalizeId, integer, positiveId, price, ratio, shopKey, normalizeBusiness, normalizeShop, normalizeOffer } = normalizeModule;

const RESOURCE = "hmp-business";
const MANAGE = "shop.manage";

interface LiveShop {
    disposeShop: () => boolean;
    disposeDuty: (() => boolean) | null;
    body: boolean;
}

interface BusinessRecord {
    business: HmpBusiness;
    shops: Map<string, HmpBusinessShop>;
    offers: Map<string, HmpBusinessOffer>;
    live: Map<string, LiveShop>;
    disposeCurrency: (() => boolean) | null;
    waiting: boolean;
}

interface SalesTally {
    day: string;
    purchases: number;
    revenue: number;
    buybacks: number;
    spent: number;
}

type Options = HmpBusinessMutationOptions<Player> | undefined;

function businessError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): string {
    return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
}

function messageOf(error: unknown): string {
    return clean(error instanceof Error ? error.message : String(error), 191) || "unknown error";
}

function hash(value: string): string {
    let result = 5381;
    for (let index = 0; index < value.length; index++) result = ((result << 5) + result + value.charCodeAt(index)) | 0;
    return (result >>> 0).toString(36);
}

/** Bank references share hmp-shops' 96-character alphabet; long shop references are shortened deterministically. */
function compactReference(prefix: string, value: string): string {
    const safe = value.replace(/[^A-Za-z0-9_.:-]/g, "_");
    const full = `${prefix}:${safe}`;
    if (full.length <= 96) return full;
    const suffix = hash(value);
    return `${prefix}:${safe.slice(0, 94 - prefix.length - suffix.length)}:${suffix}`;
}

function offerKey(shopId: string, offerId: string): string {
    return `${shopId}/${offerId}`;
}

function parseShopKey(value: string): { businessId: string; shopId: string } | null {
    const match = /^business:([^:]+):([^:]+)$/.exec(String(value || ""));
    return match ? { businessId: match[1], shopId: match[2] } : null;
}

function localDay(now: number): string {
    const date = new Date(now);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function shopAsInput(shop: HmpBusinessShop): HmpBusinessShopInput {
    return {
        id: shop.id,
        label: shop.label,
        description: shop.description,
        position: shop.position,
        areaId: shop.areaId,
        regionId: shop.regionId,
        radius: shop.radius,
        staffRadius: shop.staffRadius,
        dutyPoint: shop.dutyPoint,
        vendor: shop.vendor,
        staffing: shop.staffing,
        enabled: shop.enabled,
    };
}

function offerAsInput(offer: HmpBusinessOffer): HmpBusinessOfferInput {
    return {
        id: offer.id,
        item: offer.item,
        label: offer.label,
        buyPrice: offer.buyPrice,
        sellPrice: offer.sellPrice,
        buybackRatio: offer.buybackRatio,
        maxQuantity: offer.maxQuantity,
        unlimited: offer.unlimited,
        enabled: offer.enabled,
    };
}

function samePosition(left: { x: number; y: number; z: number } | null, right: { x: number; y: number; z: number } | null): boolean {
    if (!left || !right) return left === right;
    return left.x === right.x && left.y === right.y && left.z === right.z;
}

function createBusinessService(dependencies: BusinessDependencies): BusinessService {
    const { repository, core, inventory, interact, ui, banking, shops, jobs, lib, events, logger, migrations, config } = dependencies;
    if (!repository || !core?.characters || !inventory?.inventory || !interact?.register || !ui?.context || !banking?.accounts || !shops?.shops || !jobs?.permissions || !lib?.player) {
        throw new TypeError("business dependencies are required");
    }
    const now = dependencies.now || Date.now;
    const today = dependencies.today || (() => localDay(now()));
    const startedAt = now();
    const records = new Map<string, BusinessRecord>();
    const openMenus = new Set<number>();
    const activeStock = new Set<number>();
    const sales = new Map<string, SalesTally>();
    let state: "starting" | "ready" | "degraded" | "stopped" = "starting";
    let lastError = "";
    let startPromise: Promise<void> | null = null;
    let disposeTreasury: (() => boolean) | null = null;
    let treasuryWarned = false;

    const emit = (name: string, payload: unknown): void => {
        try { events.emit(name, payload); }
        catch (error) { logger.warn(`[hmp-business] listener for '${name}' failed`, error); }
    };

    function playerId(player: Player): number {
        const value = Number(player?.id);
        if (!Number.isSafeInteger(value) || value < 0 || typeof player?.emit !== "function") throw new TypeError("a connected player is required");
        return value;
    }

    function recordOf(rawId: string): BusinessRecord {
        const businessId = String(rawId || "").trim();
        const record = records.get(businessId);
        if (!record) throw businessError("HMP_BUSINESS_NOT_FOUND", `Business '${businessId}' does not exist.`);
        return record;
    }

    function shopOf(record: BusinessRecord, rawShopId: string): HmpBusinessShop {
        const shopId = String(rawShopId || "").trim();
        const shop = record.shops.get(shopId);
        if (!shop) throw businessError("HMP_BUSINESS_SHOP", `${record.business.label} has no counter '${shopId}'.`);
        return shop;
    }

    function offerOf(record: BusinessRecord, shopId: string, rawOfferId: string): HmpBusinessOffer {
        const offerId = String(rawOfferId || "").trim();
        const offer = record.offers.get(offerKey(shopId, offerId));
        if (!offer) throw businessError("HMP_BUSINESS_OFFER", `Counter '${shopId}' has no offer '${offerId}'.`);
        return offer;
    }

    function offersOf(record: BusinessRecord, shopId: string, includeRetired = false): HmpBusinessOffer[] {
        return [...record.offers.values()].filter((offer) => offer.shopId === shopId && (includeRetired || offer.enabled));
    }

    function boundsFor(currency: string) {
        return { floor: config.prices.floor, ceiling: config.prices.ceilings[currency] ?? config.prices.ceiling };
    }

    const buybacks = config.prices.buybacks;

    /** Server-owned worth of one unit: the config override wins, then the item definition. Null means never bought back. */
    function referenceValueOf(item: string): number | null {
        const override = buybacks.referenceValues[item];
        if (override !== undefined) return override;
        const declared = Number(inventory.items.get(item)?.referenceValue);
        return Number.isFinite(declared) && declared > 0 ? Math.trunc(declared) : null;
    }

    /** What the shop pays for one unit. Sell-only offers keep their administrator-set price; everything else derives from the ratio. */
    function buybackPriceOf(record: BusinessRecord, offer: HmpBusinessOffer): number | undefined {
        if (!buybacks.enabled) return undefined;
        if (offer.buyPrice === undefined) return offer.sellPrice;
        if (!offer.buybackRatio) return undefined;
        const reference = referenceValueOf(offer.item);
        if (reference === null) return undefined;
        const bounds = boundsFor(record.business.currency);
        const value = Math.min(bounds.ceiling, Math.floor(reference * offer.buybackRatio));
        return value >= bounds.floor ? value : undefined;
    }

    function jobOf(record: BusinessRecord) {
        return jobs.jobs.get(record.business.jobId);
    }

    function groupOf(record: BusinessRecord): string {
        return jobOf(record)?.group || `job:${record.business.jobId}`;
    }

    function organizationIdOf(record: BusinessRecord): string | null {
        const job = jobOf(record);
        return job && job.banking ? job.banking.organizationId || null : null;
    }

    function actorCharacterId(options: Options): number | null {
        const actor = options?.actor;
        if (actor === null || actor === undefined) return null;
        if (typeof actor === "number") return positiveId(actor, "actor character id");
        playerId(actor);
        const character = core.characters.active(actor);
        if (!character) throw businessError("HMP_BUSINESS_CHARACTER", "Choose a character before managing a business.");
        return character.id;
    }

    /** Resolves the acting character. Trusted callers pass no actor or `admin: true`; everyone else needs `shop.manage`. */
    async function authorize(record: BusinessRecord, options: Options, adminOnly = false): Promise<{ actorCharacterId: number | null; trusted: boolean }> {
        const actor = actorCharacterId(options);
        const trusted = actor === null || options?.admin === true;
        if (trusted) return { actorCharacterId: actor, trusted };
        if (adminOnly) throw businessError("HMP_BUSINESS_ADMIN", "Only an administrator can do that.");
        if (!await jobs.permissions.has(actor, MANAGE, record.business.jobId)) throw businessError("HMP_BUSINESS_ACCESS", `You cannot manage ${record.business.label}.`);
        return { actorCharacterId: actor, trusted };
    }

    async function audit(draft: AuditDraft): Promise<void> {
        try { await repository.audit(draft); }
        catch (error) { logger.error(`[hmp-business] could not audit '${draft.action}' for '${draft.businessId}'`, error); }
    }

    function isStaffedNow(record: BusinessRecord, shop: HmpBusinessShop): boolean {
        for (const duty of jobs.duty.list(record.business.jobId)) {
            const employee = lib.player.byId(duty.playerId);
            if (employee && employee.position && lib.position.within(employee, shop.position, shop.staffRadius)) return true;
        }
        return false;
    }

    function providerFor(record: BusinessRecord): HmpShopCurrencyProvider<Player> {
        const business = record.business;
        const currency = banking.currencies.get(business.currency);
        async function organization() {
            const organizationId = organizationIdOf(record);
            const account = organizationId ? await banking.accounts.organization(organizationId) : null;
            if (!account) throw businessError("HMP_BUSINESS_BANK", `${business.label} has no organization account.`);
            return account;
        }
        return {
            id: `business:${business.id}`,
            resource: RESOURCE,
            label: currency?.label || business.currency,
            symbol: currency?.symbol,
            balance: async (player) => (await banking.accounts.personal(player, business.currency)).balance,
            debit: async (player, amount, context) => {
                try {
                    await banking.transactions.transfer(await banking.accounts.personal(player, business.currency), await organization(), amount, {
                        resource: RESOURCE,
                        actor: player,
                        reference: compactReference("bizd", context.reference),
                        memo: `${business.label} purchase`,
                        metadata: { businessId: business.id, shopId: context.shop.id, shopReference: context.reference },
                    });
                    return true;
                } catch (error) {
                    if (errorCode(error) === "HMP_BANK_FUNDS") return false;
                    throw error;
                }
            },
            credit: async (player, amount, context) => {
                try {
                    await banking.transactions.transfer(await organization(), await banking.accounts.personal(player, business.currency), amount, {
                        resource: RESOURCE,
                        actor: player,
                        reference: compactReference("bizc", context.reference),
                        memo: `${business.label} payout`,
                        metadata: { businessId: business.id, shopId: context.shop.id, shopReference: context.reference },
                    });
                    return true;
                } catch (error) {
                    if (errorCode(error) === "HMP_BANK_FUNDS") return false;
                    throw error;
                }
            },
        };
    }

    function definitionFor(record: BusinessRecord, shop: HmpBusinessShop): { definition: HmpShopDefinition<Player>; body: boolean } | null {
        const enabledOffers = offersOf(record, shop.id);
        if (!enabledOffers.length) return null;
        const group = groupOf(record);
        const staffed = isStaffedNow(record, shop);
        const body = Boolean(shop.vendor) && shop.staffing !== "kiosk" && !staffed;
        const jobId = record.business.jobId;
        const offers: HmpShopOffer<Player>[] = [];
        for (const offer of enabledOffers) {
            const sellPrice = buybackPriceOf(record, offer);
            if (offer.buyPrice === undefined && sellPrice === undefined) continue;
            offers.push({
                id: offer.id,
                item: offer.item,
                label: offer.label,
                buyPrice: offer.buyPrice,
                sellPrice,
                stock: offer.unlimited ? null : 0,
                maxQuantity: offer.maxQuantity,
                requirements: sellPrice === undefined ? undefined : {
                    allow: async (context) => {
                        if (context.direction !== "sell") return true;
                        if (!await core.groups.has(context.player, group, 0)) return "Only staff may sell to this counter.";
                        if (await jobs.permissions.has(context.player, MANAGE, jobId)) return "Managers cannot sell to their own counters.";
                        return true;
                    },
                },
            });
        }
        if (!offers.length) return null;
        const definition: HmpShopDefinition<Player> = {
            id: shopKey(record.business.id, shop.id),
            resource: RESOURCE,
            label: shop.label,
            description: shop.description,
            currency: `business:${record.business.id}`,
            requirements: {
                character: true,
                allow: shop.staffing === "staffed"
                    ? () => {
                        const current = record.shops.get(shop.id);
                        return Boolean(current && isStaffedNow(record, current)) || "Nobody is at the counter.";
                    }
                    : undefined,
            },
            interaction: {
                position: shop.position,
                areaId: shop.areaId,
                regionId: shop.regionId,
                radius: shop.radius,
                character: body && shop.vendor ? shop.vendor : undefined,
            },
            offers,
        };
        return { definition, body };
    }

    function unpublishShop(record: BusinessRecord, shopId: string): void {
        const live = record.live.get(shopId);
        if (!live) return;
        record.live.delete(shopId);
        live.disposeShop();
        live.disposeDuty?.();
    }

    function publishShop(record: BusinessRecord, shopId: string): boolean {
        const shop = record.shops.get(shopId);
        if (!shop || !shop.enabled || !record.business.enabled || state === "stopped") { unpublishShop(record, shopId); return false; }
        if (!jobOf(record)) {
            unpublishShop(record, shopId);
            if (!record.waiting) logger.warn(`[hmp-business] '${record.business.id}' waits for job '${record.business.jobId}' to register`);
            record.waiting = true;
            return false;
        }
        record.waiting = false;
        const built = definitionFor(record, shop);
        if (!built) {
            unpublishShop(record, shopId);
            logger.warn(`[hmp-business] counter '${shop.id}' of '${record.business.id}' has no enabled offers and stays closed`);
            return false;
        }
        const previous = record.live.get(shopId);
        try {
            const disposeShop = shops.shops.register(built.definition);
            let disposeDuty: (() => boolean) | null = null;
            if (shop.dutyPoint) {
                disposeDuty = interact.register({
                    id: `business:${record.business.id}:${shop.id}:duty`,
                    resource: RESOURCE,
                    label: `Clock in at ${shop.label}`,
                    description: "Go on or off duty here.",
                    position: shop.dutyPoint,
                    areaId: shop.areaId,
                    regionId: shop.regionId,
                    radius: shop.radius,
                    requirements: { character: true, groups: [{ key: groupOf(record), minimumGrade: 0 }] },
                    handler: ({ player }) => jobs.duty.toggle(player, record.business.jobId),
                });
            } else previous?.disposeDuty?.();
            record.live.set(shopId, { disposeShop, disposeDuty, body: built.body });
            return true;
        } catch (error) {
            logger.error(`[hmp-business] could not publish counter '${shop.id}' of '${record.business.id}': ${messageOf(error)}`);
            unpublishShop(record, shopId);
            return false;
        }
    }

    function publishCurrency(record: BusinessRecord): void {
        record.disposeCurrency?.();
        record.disposeCurrency = shops.currencies.register(providerFor(record));
    }

    function publishBusiness(record: BusinessRecord): number {
        if (!record.disposeCurrency) publishCurrency(record);
        let live = 0;
        for (const shopId of record.shops.keys()) if (publishShop(record, shopId)) live++;
        return live;
    }

    function unpublishBusiness(record: BusinessRecord): void {
        for (const shopId of [...record.live.keys()]) unpublishShop(record, shopId);
        record.disposeCurrency?.();
        record.disposeCurrency = null;
    }

    function publishAll(): number {
        let live = 0;
        for (const record of records.values()) live += publishBusiness(record);
        return live;
    }

    function ensureTreasury(): void {
        if (config.houseCut.percent < 1 || disposeTreasury || banking.organizations.get(config.houseCut.organizationId)) return;
        disposeTreasury = banking.organizations.register({ id: config.houseCut.organizationId, resource: RESOURCE, label: config.houseCut.label, currency: config.houseCut.currency });
    }

    async function load(): Promise<void> {
        const loaded = await repository.loadAll();
        for (const record of records.values()) unpublishBusiness(record);
        records.clear();
        for (const business of loaded.businesses) records.set(business.id, { business, shops: new Map(), offers: new Map(), live: new Map(), disposeCurrency: null, waiting: false });
        for (const shop of loaded.shops) records.get(shop.businessId)?.shops.set(shop.id, shop);
        for (const offer of loaded.offers) records.get(offer.businessId)?.offers.set(offerKey(offer.shopId, offer.id), offer);
    }

    function start(): Promise<void> {
        if (state === "stopped") return Promise.reject(new Error("hmp-business is stopped"));
        if (startPromise) return startPromise;
        state = "starting";
        startPromise = repository.migrate(migrations)
            .then(load)
            .then(() => {
                state = "ready";
                lastError = "";
                ensureTreasury();
                publishAll();
            })
            .catch((error) => {
                state = "degraded";
                lastError = messageOf(error);
                throw error;
            });
        return startPromise;
    }

    async function seed(entries: SeedBusiness[]): Promise<number> {
        await start();
        let created = 0;
        for (const entry of entries) {
            if (records.has(entry.id)) continue;
            try {
                await createBusiness({ id: entry.id, jobId: entry.jobId, label: entry.label, currency: entry.currency, enabled: entry.enabled }, { reason: "Declared in data/hmp-business.json" });
                for (const shop of entry.shops) {
                    await addShop(entry.id, shop, { reason: "Declared in data/hmp-business.json" });
                    for (const offer of shop.offers) await setOffer(entry.id, shop.id, offer, { reason: "Declared in data/hmp-business.json" });
                }
                created++;
            } catch (error) {
                logger.error(`[hmp-business] configured business '${entry.id}' not created: ${messageOf(error)}`);
            }
        }
        return created;
    }

    // Businesses -------------------------------------------------------------------------------------------------------

    async function createBusiness(raw: HmpBusinessDefinition, options?: Options): Promise<HmpBusiness> {
        await start();
        const values = normalizeBusiness(raw);
        const actor = actorCharacterId(options);
        if (actor !== null && options?.admin !== true) throw businessError("HMP_BUSINESS_ADMIN", "Only an administrator can create a business.");
        if (records.has(values.id)) throw businessError("HMP_BUSINESS_EXISTS", `Business '${values.id}' already exists.`);
        if (!banking.currencies.get(values.currency)) throw businessError("HMP_BUSINESS_CURRENCY", `Currency '${values.currency}' is not registered with hmp-banking.`);
        const business = await repository.createBusiness(values);
        if (!business) throw businessError("HMP_BUSINESS_EXISTS", `Business '${values.id}' already exists.`);
        const record: BusinessRecord = { business, shops: new Map(), offers: new Map(), live: new Map(), disposeCurrency: null, waiting: false };
        records.set(business.id, record);
        await audit({ businessId: business.id, action: "business.create", actorCharacterId: actor, after: { ...values }, reason: options?.reason });
        publishBusiness(record);
        emit("hmp:business:changed", { business, action: "create" });
        return business;
    }

    async function updateBusiness(rawId: string, patch: { label?: string; currency?: string; enabled?: boolean }, options?: Options): Promise<HmpBusiness> {
        await start();
        const record = recordOf(rawId);
        const adminOnly = patch.currency !== undefined || patch.enabled !== undefined;
        const { actorCharacterId: actor } = await authorize(record, options, adminOnly);
        const before = record.business;
        const values = normalizeBusiness({ id: before.id, jobId: before.jobId, label: patch.label ?? before.label, currency: patch.currency ?? before.currency, enabled: patch.enabled ?? before.enabled });
        if (!banking.currencies.get(values.currency)) throw businessError("HMP_BUSINESS_CURRENCY", `Currency '${values.currency}' is not registered with hmp-banking.`);
        const business = await repository.updateBusiness(values);
        record.business = business;
        await audit({ businessId: business.id, action: "business.update", actorCharacterId: actor, before: { label: before.label, currency: before.currency, enabled: before.enabled }, after: { label: business.label, currency: business.currency, enabled: business.enabled }, reason: options?.reason });
        if (before.currency !== business.currency) publishCurrency(record);
        for (const shopId of record.shops.keys()) publishShop(record, shopId);
        emit("hmp:business:changed", { business, action: "update" });
        return business;
    }

    async function removeBusiness(rawId: string, options?: Options): Promise<boolean> {
        await start();
        const record = recordOf(rawId);
        const { actorCharacterId: actor } = await authorize(record, options, true);
        unpublishBusiness(record);
        records.delete(record.business.id);
        const removed = await repository.deleteBusiness(record.business.id);
        await audit({ businessId: record.business.id, action: "business.remove", actorCharacterId: actor, before: { label: record.business.label, jobId: record.business.jobId }, reason: options?.reason });
        emit("hmp:business:changed", { business: record.business, action: "remove" });
        return removed;
    }

    async function managed(target: Player | number): Promise<HmpBusiness[]> {
        const result: HmpBusiness[] = [];
        for (const record of records.values()) {
            if (await jobs.permissions.has(target, MANAGE, record.business.jobId)) result.push(record.business);
        }
        return result;
    }

    async function sync(rawId?: string): Promise<number> {
        await start();
        if (rawId) return publishBusiness(recordOf(rawId));
        return publishAll();
    }

    // Counters ---------------------------------------------------------------------------------------------------------

    async function addShop(rawBusinessId: string, raw: HmpBusinessShopInput, options?: Options): Promise<HmpBusinessShop> {
        await start();
        const record = recordOf(rawBusinessId);
        const { actorCharacterId: actor } = await authorize(record, options, true);
        const shop = normalizeShop(record.business.id, raw);
        if (record.shops.has(shop.id)) throw businessError("HMP_BUSINESS_SHOP_EXISTS", `${record.business.label} already has a counter '${shop.id}'.`);
        await repository.saveShop(shop);
        record.shops.set(shop.id, shop);
        await audit({ businessId: record.business.id, shopId: shop.id, action: "shop.add", actorCharacterId: actor, after: { label: shop.label, position: shop.position, staffing: shop.staffing }, reason: options?.reason });
        publishShop(record, shop.id);
        emit("hmp:business:shop", { business: record.business, shop, action: "add" });
        return shop;
    }

    async function updateShop(rawBusinessId: string, rawShopId: string, patch: Partial<Omit<HmpBusinessShopInput, "id">>, options?: Options): Promise<HmpBusinessShop> {
        await start();
        const record = recordOf(rawBusinessId);
        const before = shopOf(record, rawShopId);
        const { actorCharacterId: actor, trusted } = await authorize(record, options);
        const shop = normalizeShop(record.business.id, { ...shopAsInput(before), ...patch, id: before.id });
        const moved = !samePosition(before.position, shop.position) || !samePosition(before.dutyPoint, shop.dutyPoint)
            || before.areaId !== shop.areaId || before.regionId !== shop.regionId || before.radius !== shop.radius;
        if (moved && !trusted) throw businessError("HMP_BUSINESS_ADMIN", "Moving a counter needs an administrator.");
        await repository.saveShop(shop);
        record.shops.set(shop.id, shop);
        const changed = (["label", "description", "staffing", "enabled", "staffRadius", "radius", "areaId", "regionId"] as const).filter((key) => before[key] !== shop[key]);
        const beforeState: Record<string, unknown> = {};
        const afterState: Record<string, unknown> = {};
        for (const key of changed) { beforeState[key] = before[key]; afterState[key] = shop[key]; }
        if (moved) { beforeState.position = before.position; afterState.position = shop.position; beforeState.dutyPoint = before.dutyPoint; afterState.dutyPoint = shop.dutyPoint; }
        if (JSON.stringify(before.vendor) !== JSON.stringify(shop.vendor)) { beforeState.vendor = before.vendor; afterState.vendor = shop.vendor; }
        const action = before.enabled !== shop.enabled ? (shop.enabled ? "shop.open" : "shop.close") : before.staffing !== shop.staffing ? "shop.staffing" : "vendor" in afterState ? "shop.vendor" : "shop.update";
        await audit({ businessId: record.business.id, shopId: shop.id, action, actorCharacterId: actor, before: beforeState, after: afterState, reason: options?.reason });
        publishShop(record, shop.id);
        emit("hmp:business:shop", { business: record.business, shop, action: "update" });
        return shop;
    }

    async function removeShop(rawBusinessId: string, rawShopId: string, options?: Options): Promise<boolean> {
        await start();
        const record = recordOf(rawBusinessId);
        const shop = shopOf(record, rawShopId);
        const { actorCharacterId: actor } = await authorize(record, options, true);
        unpublishShop(record, shop.id);
        const removed = await repository.deleteShop(record.business.id, shop.id);
        record.shops.delete(shop.id);
        for (const key of [...record.offers.keys()]) if (key.startsWith(`${shop.id}/`)) record.offers.delete(key);
        await audit({ businessId: record.business.id, shopId: shop.id, action: "shop.remove", actorCharacterId: actor, before: { label: shop.label, position: shop.position }, reason: options?.reason });
        emit("hmp:business:shop", { business: record.business, shop, action: "remove" });
        return removed;
    }

    // Offers -----------------------------------------------------------------------------------------------------------

    async function setOffer(rawBusinessId: string, rawShopId: string, raw: HmpBusinessOfferInput, options?: Options): Promise<HmpBusinessOffer> {
        await start();
        const record = recordOf(rawBusinessId);
        const shop = shopOf(record, rawShopId);
        const { actorCharacterId: actor, trusted } = await authorize(record, options);
        const { offer, stock } = normalizeOffer(record.business.id, shop.id, raw, boundsFor(record.business.currency));
        if (!inventory.items.get(offer.item)) throw businessError("HMP_BUSINESS_ITEM", `Item '${offer.item}' does not exist.`);
        if (offer.unlimited && !trusted) throw businessError("HMP_BUSINESS_ADMIN", "Only an administrator can offer unlimited stock.");
        if (offer.sellPrice !== undefined && !trusted) throw businessError("HMP_BUSINESS_BUYBACK", "Buyback prices derive from the item's reference value; set a buyback ratio instead.");
        const before = record.offers.get(offerKey(shop.id, offer.id)) || null;
        if (offer.buybackRatio !== null && offer.buybackRatio !== (before?.buybackRatio ?? null)) {
            if (!buybacks.enabled && !trusted) throw businessError("HMP_BUSINESS_BUYBACK", "Buybacks are disabled on this server.");
            if (offer.buybackRatio > buybacks.maxRatio) throw businessError("HMP_BUSINESS_BUYBACK", `The buyback ratio may not exceed ${buybacks.maxRatio}.`);
        }
        await repository.saveOffer(offer);
        record.offers.set(offerKey(shop.id, offer.id), offer);
        if (!before && stock !== null) await shops.stock.set(shopKey(record.business.id, shop.id), offer.id, stock);
        const priceChanged = Boolean(before && (before.buyPrice !== offer.buyPrice || before.sellPrice !== offer.sellPrice || before.buybackRatio !== offer.buybackRatio));
        await audit({
            businessId: record.business.id, shopId: shop.id, offerId: offer.id,
            action: before ? (priceChanged ? "offer.price" : "offer.update") : "offer.add",
            actorCharacterId: actor,
            before: before ? { ...offerAsInput(before) } : null,
            after: { ...offerAsInput(offer), ...(stock === null ? {} : { stock }) },
            reason: options?.reason,
        });
        publishShop(record, shop.id);
        emit("hmp:business:offer", { business: record.business, shop, offer, action: before ? "update" : "add" });
        return offer;
    }

    async function setPrices(rawBusinessId: string, rawShopId: string, rawOfferId: string, prices: { buyPrice?: number | null; sellPrice?: number | null; buybackRatio?: number | null }, options?: Options): Promise<HmpBusinessOffer> {
        const record = recordOf(rawBusinessId);
        const shop = shopOf(record, rawShopId);
        const before = offerOf(record, shop.id, rawOfferId);
        const bounds = boundsFor(record.business.currency);
        const buyPrice = prices.buyPrice === undefined ? before.buyPrice : price(prices.buyPrice, `offer '${before.id}' buy price`, bounds);
        const sellPrice = prices.sellPrice === undefined ? before.sellPrice : price(prices.sellPrice, `offer '${before.id}' sell price`, bounds);
        const buybackRatio = prices.buybackRatio === undefined ? before.buybackRatio : ratio(prices.buybackRatio, `offer '${before.id}' buyback ratio`);
        return setOffer(record.business.id, shop.id, { ...offerAsInput(before), buyPrice: buyPrice ?? null, sellPrice: sellPrice ?? null, buybackRatio }, options);
    }

    async function setOfferEnabled(rawBusinessId: string, rawShopId: string, rawOfferId: string, enabled: boolean, options?: Options): Promise<HmpBusinessOffer> {
        await start();
        const record = recordOf(rawBusinessId);
        const shop = shopOf(record, rawShopId);
        const before = offerOf(record, shop.id, rawOfferId);
        const { actorCharacterId: actor } = await authorize(record, options);
        if (before.enabled === enabled) return before;
        const offer = Object.freeze({ ...before, enabled });
        await repository.saveOffer(offer);
        record.offers.set(offerKey(shop.id, offer.id), offer);
        await audit({ businessId: record.business.id, shopId: shop.id, offerId: offer.id, action: enabled ? "offer.restore" : "offer.retire", actorCharacterId: actor, before: { enabled: before.enabled }, after: { enabled }, reason: options?.reason });
        publishShop(record, shop.id);
        emit("hmp:business:offer", { business: record.business, shop, offer, action: enabled ? "restore" : "retire" });
        return offer;
    }

    // Stock ------------------------------------------------------------------------------------------------------------

    function stockTarget(rawBusinessId: string, rawShopId: string, rawOfferId: string) {
        const record = recordOf(rawBusinessId);
        const shop = shopOf(record, rawShopId);
        const offer = offerOf(record, shop.id, rawOfferId);
        return { record, shop, offer, key: shopKey(record.business.id, shop.id) };
    }

    function finiteOffer(offer: HmpBusinessOffer): void {
        if (offer.unlimited) throw businessError("HMP_BUSINESS_STOCK", `Offer '${offer.id}' has unlimited stock.`);
    }

    async function getStock(rawBusinessId: string, rawShopId: string, rawOfferId: string): Promise<number | null> {
        const { offer, key } = stockTarget(rawBusinessId, rawShopId, rawOfferId);
        return offer.unlimited ? null : shops.stock.get(key, offer.id);
    }

    async function setStock(rawBusinessId: string, rawShopId: string, rawOfferId: string, rawQuantity: number, options?: Options): Promise<number> {
        await start();
        const { record, shop, offer, key } = stockTarget(rawBusinessId, rawShopId, rawOfferId);
        const { actorCharacterId: actor } = await authorize(record, options, true);
        finiteOffer(offer);
        const quantity = integer(rawQuantity, 0, 0, 2147483647);
        const before = await shops.stock.get(key, offer.id);
        const after = await shops.stock.set(key, offer.id, quantity);
        await audit({ businessId: record.business.id, shopId: shop.id, offerId: offer.id, action: "stock.set", actorCharacterId: actor, before: { stock: before }, after: { stock: after }, reason: options?.reason });
        return after;
    }

    function withStockLock<T>(player: Player, work: () => Promise<T>): Promise<T> {
        const owner = playerId(player);
        if (activeStock.has(owner)) throw businessError("HMP_BUSINESS_BUSY", "A stock movement is already in progress.");
        activeStock.add(owner);
        return work().finally(() => activeStock.delete(owner));
    }

    function quantityValue(raw: number): number {
        const quantity = integer(raw, 0, 0, 1000000);
        if (quantity < 1) throw businessError("HMP_BUSINESS_QUANTITY", "The quantity is invalid.");
        return quantity;
    }

    async function restock(player: Player, rawBusinessId: string, rawShopId: string, rawOfferId: string, rawQuantity: number, options?: Options): Promise<number> {
        await start();
        const { record, shop, offer, key } = stockTarget(rawBusinessId, rawShopId, rawOfferId);
        const { actorCharacterId: actor } = await authorize(record, { ...options, actor: options?.actor ?? player });
        finiteOffer(offer);
        const quantity = quantityValue(rawQuantity);
        return withStockLock(player, async () => {
            if (!await inventory.inventory.has(player, offer.item, quantity)) throw businessError("HMP_BUSINESS_ITEMS", `You do not carry ${quantity} × ${offer.label || offer.item}.`);
            const removed = await inventory.inventory.remove(player, offer.item, quantity);
            if (removed !== quantity) {
                if (removed > 0) await inventory.inventory.add(player, offer.item, removed);
                throw businessError("HMP_BUSINESS_ITEMS", "Your inventory released only part of that quantity.");
            }
            let after: number;
            try { after = await shops.stock.adjust(key, offer.id, quantity); }
            catch (error) {
                try { await inventory.inventory.add(player, offer.item, quantity); }
                catch (compensationError) { logger.error(`[hmp-business] restock compensation failed for #${player.id} on '${key}/${offer.id}'`, compensationError); }
                throw error;
            }
            await audit({ businessId: record.business.id, shopId: shop.id, offerId: offer.id, action: "stock.restock", actorCharacterId: actor, before: { stock: after - quantity }, after: { stock: after, quantity }, reason: options?.reason });
            emit("hmp:business:stock", { business: record.business, shop, offer, action: "restock", quantity, stock: after, player });
            return after;
        });
    }

    async function withdraw(player: Player, rawBusinessId: string, rawShopId: string, rawOfferId: string, rawQuantity: number, options?: Options): Promise<number> {
        await start();
        const { record, shop, offer, key } = stockTarget(rawBusinessId, rawShopId, rawOfferId);
        const { actorCharacterId: actor } = await authorize(record, { ...options, actor: options?.actor ?? player });
        finiteOffer(offer);
        const requested = quantityValue(rawQuantity);
        return withStockLock(player, async () => {
            const current = await shops.stock.get(key, offer.id);
            if (!current || current < 1) throw businessError("HMP_BUSINESS_STOCK", `The shelf holds no ${offer.label || offer.item}.`);
            const quantity = Math.min(requested, current);
            const after = await shops.stock.adjust(key, offer.id, -quantity);
            let added = 0;
            try { added = await inventory.inventory.add(player, offer.item, quantity); }
            catch (error) {
                try { await shops.stock.adjust(key, offer.id, quantity); }
                catch (compensationError) { logger.error(`[hmp-business] withdraw compensation failed for #${player.id} on '${key}/${offer.id}'`, compensationError); }
                throw error;
            }
            if (added !== quantity) {
                try { await shops.stock.adjust(key, offer.id, quantity - added); }
                catch (compensationError) { logger.error(`[hmp-business] partial withdraw compensation failed for #${player.id} on '${key}/${offer.id}'`, compensationError); }
                throw businessError("HMP_BUSINESS_ITEMS", "Your inventory accepted only part of that quantity.");
            }
            await audit({ businessId: record.business.id, shopId: shop.id, offerId: offer.id, action: "stock.withdraw", actorCharacterId: actor, before: { stock: current }, after: { stock: after, quantity }, reason: options?.reason });
            emit("hmp:business:stock", { business: record.business, shop, offer, action: "withdraw", quantity, stock: after, player });
            return after;
        });
    }

    async function transfer(rawBusinessId: string, rawFromShopId: string, rawToShopId: string, rawOfferId: string, rawQuantity: number, options?: Options): Promise<{ from: number; to: number }> {
        await start();
        const source = stockTarget(rawBusinessId, rawFromShopId, rawOfferId);
        const destination = stockTarget(rawBusinessId, rawToShopId, rawOfferId);
        if (source.shop.id === destination.shop.id) throw businessError("HMP_BUSINESS_SHOP", "Choose two different counters.");
        const { actorCharacterId: actor } = await authorize(source.record, options);
        finiteOffer(source.offer);
        finiteOffer(destination.offer);
        if (source.offer.item !== destination.offer.item) throw businessError("HMP_BUSINESS_OFFER", "Both counters must sell the same item under that offer id.");
        const quantity = quantityValue(rawQuantity);
        const from = await shops.stock.adjust(source.key, source.offer.id, -quantity);
        let to: number;
        try { to = await shops.stock.adjust(destination.key, destination.offer.id, quantity); }
        catch (error) {
            try { await shops.stock.adjust(source.key, source.offer.id, quantity); }
            catch (compensationError) { logger.error(`[hmp-business] transfer compensation failed on '${source.key}/${source.offer.id}'`, compensationError); }
            throw error;
        }
        await audit({ businessId: source.record.business.id, shopId: source.shop.id, offerId: source.offer.id, action: "stock.transfer", actorCharacterId: actor, before: { from: from + quantity, to: to - quantity }, after: { from, to, quantity, toShopId: destination.shop.id }, reason: options?.reason });
        emit("hmp:business:stock", { business: source.record.business, shop: source.shop, offer: source.offer, action: "transfer", quantity, stock: from, toShop: destination.shop, toStock: to });
        return { from, to };
    }

    // Books and events -------------------------------------------------------------------------------------------------

    function tally(businessId: string, shopId: string): SalesTally {
        const key = offerKey(businessId, shopId);
        const day = today();
        let entry = sales.get(key);
        if (!entry || entry.day !== day) {
            entry = { day, purchases: 0, revenue: 0, buybacks: 0, spent: 0 };
            sales.set(key, entry);
        }
        return entry;
    }

    async function summary(rawBusinessId: string, options?: Options): Promise<HmpBusinessBooks> {
        const record = recordOf(rawBusinessId);
        await authorize(record, options);
        const organizationId = organizationIdOf(record);
        const account = organizationId ? await banking.accounts.organization(organizationId) : null;
        const day = today();
        const entries: HmpBusinessShopSales[] = [...record.shops.values()].map((shop) => {
            const entry = sales.get(offerKey(record.business.id, shop.id));
            const current = entry && entry.day === day ? entry : null;
            return { shopId: shop.id, label: shop.label, purchases: current?.purchases || 0, revenue: current?.revenue || 0, buybacks: current?.buybacks || 0, spent: current?.spent || 0 };
        });
        return { businessId: record.business.id, currency: record.business.currency, balance: account ? account.balance : null, day, shops: entries };
    }

    async function onPurchased(event: ShopTradeEvent): Promise<void> {
        if (!event?.shop || event.shop.resource !== RESOURCE) return;
        const parsed = parseShopKey(event.shop.id);
        if (!parsed) return;
        const entry = tally(parsed.businessId, parsed.shopId);
        entry.purchases += 1;
        entry.revenue += Number(event.transaction?.totalPrice) || 0;
        const percent = config.houseCut.percent;
        const total = Number(event.transaction?.totalPrice) || 0;
        const cut = Math.floor(total * percent / 100);
        if (percent < 1 || cut < 1) return;
        const record = records.get(parsed.businessId);
        if (!record) return;
        const organizationId = organizationIdOf(record);
        const [source, treasury] = await Promise.all([
            organizationId ? banking.accounts.organization(organizationId) : Promise.resolve(null),
            banking.accounts.organization(config.houseCut.organizationId),
        ]);
        if (!source || !treasury || source.currency !== treasury.currency) {
            if (!treasuryWarned) logger.warn(`[hmp-business] house cut skipped: treasury '${config.houseCut.organizationId}' or the '${record.business.id}' account is unavailable or uses another currency`);
            treasuryWarned = true;
            return;
        }
        try {
            await banking.transactions.transfer(source, treasury, cut, {
                resource: RESOURCE,
                reference: compactReference("bizcut", event.transaction.reference),
                memo: `${record.business.label} house cut`,
                metadata: { businessId: record.business.id, shopId: parsed.shopId, shopReference: event.transaction.reference, percent },
            });
        } catch (error) {
            logger.warn(`[hmp-business] house cut for '${event.transaction.reference}' failed: ${messageOf(error)}`);
        }
    }

    function onSold(event: ShopTradeEvent): void {
        if (!event?.shop || event.shop.resource !== RESOURCE) return;
        const parsed = parseShopKey(event.shop.id);
        if (!parsed) return;
        const entry = tally(parsed.businessId, parsed.shopId);
        entry.buybacks += 1;
        entry.spent += Number(event.transaction?.totalPrice) || 0;
    }

    function onDuty(event: DutyEvent): void {
        if (state !== "ready") return;
        const jobId = event?.job?.id;
        for (const record of records.values()) {
            if (jobId && record.business.jobId !== jobId) continue;
            for (const shopId of record.shops.keys()) {
                const shop = record.shops.get(shopId)!;
                const live = record.live.get(shopId);
                if (!live) { publishShop(record, shopId); continue; }
                const body = Boolean(shop.vendor) && shop.staffing !== "kiosk" && !isStaffedNow(record, shop);
                if (body !== live.body) publishShop(record, shopId);
            }
        }
    }

    function onResourceStart(name?: string): void {
        if (state !== "ready" || !name || name === RESOURCE) return;
        for (const record of records.values()) if (record.waiting || record.live.size < [...record.shops.values()].filter((shop) => shop.enabled).length) publishBusiness(record);
    }

    // Management menu --------------------------------------------------------------------------------------------------

    function money(amount: number, record: BusinessRecord): string {
        const currency = banking.currencies.get(record.business.currency);
        return currency?.symbol ? `${currency.symbol}${amount}` : `${amount} ${currency?.label || record.business.currency}`;
    }

    function itemLabel(offer: HmpBusinessOffer): string {
        return offer.label || inventory.items.get(offer.item)?.label || offer.item;
    }

    async function pickShop(player: Player, record: BusinessRecord, title: string, filter: (shop: HmpBusinessShop) => boolean = () => true): Promise<HmpBusinessShop | null> {
        const candidates = [...record.shops.values()].filter(filter);
        if (!candidates.length) { ui.notify(player, { description: "No counter is available for that.", tone: "warning" }); return null; }
        if (candidates.length === 1) return candidates[0];
        const selected = await ui.context(player, {
            title,
            description: "Choose a counter.",
            options: candidates.map((shop) => ({ id: shop.id, title: shop.label, description: shop.description || (shop.areaId ? `Area ${shop.areaId}` : undefined), metadata: [{ label: "Status", value: shop.enabled ? (isStaffedNow(record, shop) ? "Open · staffed" : "Open") : "Closed" }, { label: "Staffing", value: shop.staffing }] })),
            canClose: true,
        });
        return selected ? record.shops.get(selected) || null : null;
    }

    async function pickOffer(player: Player, record: BusinessRecord, shop: HmpBusinessShop, title: string, includeRetired = false, filter: (offer: HmpBusinessOffer) => boolean = () => true): Promise<HmpBusinessOffer | null> {
        const candidates = offersOf(record, shop.id, includeRetired).filter(filter);
        if (!candidates.length) { ui.notify(player, { description: `${shop.label} has no offers for that.`, tone: "warning" }); return null; }
        const key = shopKey(record.business.id, shop.id);
        const stocks = await Promise.all(candidates.map((offer) => offer.unlimited ? Promise.resolve(null) : shops.stock.get(key, offer.id)));
        const selected = await ui.context(player, {
            title,
            description: shop.label,
            options: candidates.map((offer, index) => ({
                id: offer.id,
                title: itemLabel(offer),
                description: [offer.buyPrice === undefined ? "" : `Customers pay ${money(offer.buyPrice, record)}`, buybackPriceOf(record, offer) === undefined ? "" : `Buys back at ${money(buybackPriceOf(record, offer)!, record)}`].filter(Boolean).join(" · ") || undefined,
                tone: offer.enabled ? undefined : "warning",
                metadata: [
                    { label: "Stock", value: offer.unlimited ? "Unlimited" : String(stocks[index] ?? 0) },
                    ...(offer.enabled ? [] : [{ label: "Status", value: "Retired" }]),
                ],
            })),
            canClose: true,
        });
        return selected ? candidates.find((offer) => offer.id === selected) || null : null;
    }

    async function quantityPrompt(player: Player, title: string, maximum: number, fallback = 1): Promise<number | null> {
        if (maximum < 1) return null;
        if (maximum === 1) return 1;
        const response = await ui.input(player, { title, fields: [{ name: "quantity", label: "Quantity", type: "number", required: true, default: Math.min(fallback, maximum), min: 1, max: maximum }], submitLabel: "Continue", allowCancel: true });
        if (!response) return null;
        return integer(response.quantity, 1, 1, maximum);
    }

    async function pricesFlow(player: Player, record: BusinessRecord): Promise<unknown> {
        const shop = await pickShop(player, record, "Set prices");
        if (!shop) return null;
        const offer = await pickOffer(player, record, shop, "Set prices");
        if (!offer) return null;
        if (offer.buyPrice === undefined) { ui.notify(player, { description: `${itemLabel(offer)} is a buyback-only offer whose price an administrator set.`, tone: "warning" }); return null; }
        const bounds = boundsFor(record.business.currency);
        const reference = buybacks.enabled ? referenceValueOf(offer.item) : null;
        const response = await ui.input(player, {
            title: `${itemLabel(offer)} prices`,
            fields: [
                { name: "buyPrice", label: "Customers pay", type: "number", description: `${bounds.floor} to ${bounds.ceiling}.`, required: true, default: offer.buyPrice, min: bounds.floor, max: bounds.ceiling },
                ...(reference === null ? [] : [{ name: "buybackRatio", label: "Buyback share", type: "number" as const, description: `Share of the reference value ${money(reference, record)} the shop pays staff, 0 to ${buybacks.maxRatio}. Leave empty to stop buying back.`, default: offer.buybackRatio ?? "", min: 0, max: buybacks.maxRatio }]),
                { name: "reason", label: "Reason", type: "text" },
            ],
            submitLabel: "Save",
            allowCancel: true,
        });
        if (!response) return null;
        const optional = (value: unknown) => value === "" || value === undefined || value === null ? null : Number(value);
        const updated = await setPrices(record.business.id, shop.id, offer.id, { buyPrice: optional(response.buyPrice), ...(reference === null ? {} : { buybackRatio: optional(response.buybackRatio) }) }, { actor: player, reason: clean(response.reason, 191) });
        const buyback = buybackPriceOf(record, updated);
        ui.notify(player, { description: `${itemLabel(updated)} now sells for ${money(updated.buyPrice!, record)}${buyback === undefined ? "" : ` and buys back at ${money(buyback, record)}`}.`, tone: "success" });
        return updated;
    }

    async function restockFlow(player: Player, record: BusinessRecord): Promise<unknown> {
        const shop = await pickShop(player, record, "Restock");
        if (!shop) return null;
        const offer = await pickOffer(player, record, shop, "Restock", false, (candidate) => !candidate.unlimited);
        if (!offer) return null;
        const owned = await inventory.inventory.count(player, offer.item);
        if (owned < 1) { ui.notify(player, { description: `You do not carry any ${itemLabel(offer)}.`, tone: "warning" }); return null; }
        const quantity = await quantityPrompt(player, `Shelve ${itemLabel(offer)}`, owned, owned);
        if (!quantity) return null;
        const stock = await restock(player, record.business.id, shop.id, offer.id, quantity);
        ui.notify(player, { description: `Shelved ${quantity} × ${itemLabel(offer)}. ${shop.label} now holds ${stock}.`, tone: "success" });
        return stock;
    }

    async function withdrawFlow(player: Player, record: BusinessRecord): Promise<unknown> {
        const shop = await pickShop(player, record, "Withdraw stock");
        if (!shop) return null;
        const offer = await pickOffer(player, record, shop, "Withdraw stock", true, (candidate) => !candidate.unlimited);
        if (!offer) return null;
        const current = await shops.stock.get(shopKey(record.business.id, shop.id), offer.id);
        if (!current) { ui.notify(player, { description: `The shelf holds no ${itemLabel(offer)}.`, tone: "warning" }); return null; }
        const quantity = await quantityPrompt(player, `Take ${itemLabel(offer)}`, current);
        if (!quantity) return null;
        const stock = await withdraw(player, record.business.id, shop.id, offer.id, quantity);
        ui.notify(player, { description: `Took ${quantity} × ${itemLabel(offer)}. ${shop.label} now holds ${stock}.`, tone: "success" });
        return stock;
    }

    async function transferFlow(player: Player, record: BusinessRecord): Promise<unknown> {
        if (record.shops.size < 2) { ui.notify(player, { description: `${record.business.label} has only one counter.`, tone: "warning" }); return null; }
        const from = await pickShop(player, record, "Transfer from");
        if (!from) return null;
        const offer = await pickOffer(player, record, from, "Transfer stock", true, (candidate) => !candidate.unlimited);
        if (!offer) return null;
        const to = await pickShop(player, record, "Transfer to", (candidate) => candidate.id !== from.id && record.offers.has(offerKey(candidate.id, offer.id)));
        if (!to) return null;
        const current = await shops.stock.get(shopKey(record.business.id, from.id), offer.id);
        if (!current) { ui.notify(player, { description: `${from.label} holds no ${itemLabel(offer)}.`, tone: "warning" }); return null; }
        const quantity = await quantityPrompt(player, `Move ${itemLabel(offer)} to ${to.label}`, current);
        if (!quantity) return null;
        const result = await transfer(record.business.id, from.id, to.id, offer.id, quantity, { actor: player });
        ui.notify(player, { description: `Moved ${quantity} × ${itemLabel(offer)}. ${from.label}: ${result.from}, ${to.label}: ${result.to}.`, tone: "success" });
        return result;
    }

    async function addOfferFlow(player: Player, record: BusinessRecord): Promise<unknown> {
        const shop = await pickShop(player, record, "Add an offer");
        if (!shop) return null;
        const bounds = boundsFor(record.business.currency);
        const response = await ui.input(player, {
            title: `New offer at ${shop.label}`,
            fields: [
                { name: "item", label: "Item name", type: "text", required: true, placeholder: "native:wiggenweld_potion" },
                { name: "buyPrice", label: "Customers pay", type: "number", required: true, min: bounds.floor, max: bounds.ceiling },
                ...(buybacks.enabled ? [{ name: "buybackRatio", label: "Buyback share", type: "number" as const, description: `Share of the item's reference value the shop pays staff, 0 to ${buybacks.maxRatio}. Ignored for items without a reference value.`, min: 0, max: buybacks.maxRatio }] : []),
                { name: "maxQuantity", label: "Maximum per purchase", type: "number", default: 10, min: 1, max: 1000000 },
                { name: "reason", label: "Reason", type: "text" },
            ],
            submitLabel: "Add",
            allowCancel: true,
        });
        if (!response) return null;
        const item = clean(response.item, 64);
        const optional = (value: unknown) => value === "" || value === undefined || value === null ? null : Number(value);
        const offer = await setOffer(record.business.id, shop.id, { id: item, item, buyPrice: optional(response.buyPrice), buybackRatio: buybacks.enabled ? optional(response.buybackRatio) : null, maxQuantity: Number(response.maxQuantity) || 10 }, { actor: player, reason: clean(response.reason, 191) });
        ui.notify(player, { description: `${itemLabel(offer)} is now listed at ${shop.label}. Restock it from your inventory.`, tone: "success" });
        return offer;
    }

    async function retireFlow(player: Player, record: BusinessRecord): Promise<unknown> {
        const shop = await pickShop(player, record, "Retire or restore an offer");
        if (!shop) return null;
        const offer = await pickOffer(player, record, shop, "Retire or restore", true);
        if (!offer) return null;
        const restoring = !offer.enabled;
        const confirmation = await ui.alert(player, { title: `${restoring ? "Restore" : "Retire"} ${itemLabel(offer)}?`, content: restoring ? "Customers will see it again." : "Customers will no longer see it. Stock stays on the shelf.", confirmLabel: restoring ? "Restore" : "Retire", cancel: true });
        if (confirmation !== "confirm") return null;
        const updated = await setOfferEnabled(record.business.id, shop.id, offer.id, restoring, { actor: player });
        ui.notify(player, { description: `${itemLabel(updated)} ${restoring ? "restored" : "retired"}.`, tone: "success" });
        return updated;
    }

    async function countersFlow(player: Player, record: BusinessRecord): Promise<unknown> {
        const shop = await pickShop(player, record, "Counters");
        if (!shop) return null;
        const action = await ui.context(player, {
            title: shop.label,
            description: `${shop.enabled ? "Open" : "Closed"} · ${shop.staffing}${shop.vendor ? ` · vendor ${shop.vendor.label || shop.vendor.characterId}` : ""}`,
            options: [
                { id: "toggle", title: shop.enabled ? "Close this counter" : "Open this counter", description: shop.enabled ? "Customers can no longer trade here." : "Customers can trade here again.", tone: shop.enabled ? "warning" : undefined },
                { id: "staffing", title: "Staffing policy", description: "always, staffed or kiosk" },
                { id: "vendor", title: "Vendor body", description: shop.vendor ? "Change or remove the stand-in vendor." : "Add a stand-in vendor." },
            ],
            canClose: true,
        });
        if (action === "toggle") {
            const updated = await updateShop(record.business.id, shop.id, { enabled: !shop.enabled }, { actor: player });
            ui.notify(player, { description: `${updated.label} is now ${updated.enabled ? "open" : "closed"}.`, tone: "success" });
            return updated;
        }
        if (action === "staffing") {
            const staffing = await ui.context(player, {
                title: "Staffing policy",
                options: [
                    { id: "always", title: "Always open", description: "The vendor body trades while nobody is on duty." },
                    { id: "staffed", title: "Staffed only", description: "Trades only while an employee is on duty at the counter." },
                    { id: "kiosk", title: "Kiosk", description: "Always open, never shows a vendor body." },
                ].map((option) => ({ ...option, disabled: option.id === shop.staffing })),
                canClose: true,
            });
            if (!staffing) return null;
            const updated = await updateShop(record.business.id, shop.id, { staffing: staffing as HmpBusinessShop["staffing"] }, { actor: player });
            ui.notify(player, { description: `${updated.label} is now ${updated.staffing}.`, tone: "success" });
            return updated;
        }
        if (action === "vendor") {
            const response = await ui.input(player, {
                title: "Vendor body",
                fields: [
                    { name: "characterId", label: "Character id", type: "text", description: "Leave empty to remove the vendor.", default: shop.vendor?.characterId || "", placeholder: "PercivalPippin" },
                    { name: "yaw", label: "Yaw", type: "number", default: shop.vendor?.yaw ?? 0, min: -360, max: 360 },
                    { name: "label", label: "Nameplate", type: "text", default: shop.vendor?.label || "" },
                ],
                submitLabel: "Save",
                allowCancel: true,
            });
            if (!response) return null;
            const characterId = clean(response.characterId, 64);
            const updated = await updateShop(record.business.id, shop.id, { vendor: characterId ? { characterId, yaw: Number(response.yaw) || 0, label: clean(response.label, 80) || undefined } : null }, { actor: player });
            ui.notify(player, { description: updated.vendor ? `${updated.vendor.characterId} now minds ${updated.label} when nobody is on duty.` : `${updated.label} has no vendor body.`, tone: "success" });
            return updated;
        }
        return null;
    }

    async function booksFlow(player: Player, record: BusinessRecord): Promise<unknown> {
        const books = await summary(record.business.id, { actor: player });
        const key = (shop: HmpBusinessShop) => shopKey(record.business.id, shop.id);
        const stocks = await Promise.all([...record.shops.values()].map(async (shop) => {
            const lines = await Promise.all(offersOf(record, shop.id).map(async (offer) => `${itemLabel(offer)} ${offer.unlimited ? "∞" : await shops.stock.get(key(shop), offer.id) ?? 0}`));
            return `${shop.label}: ${lines.join(", ") || "no offers"}`;
        }));
        const content = [
            `Balance: ${books.balance === null ? "no organization account" : money(books.balance, record)}`,
            `Today (${books.day}):`,
            ...books.shops.map((entry) => `  ${entry.label}: ${entry.purchases} sale(s) for ${money(entry.revenue, record)}, ${entry.buybacks} buyback(s) for ${money(entry.spent, record)}`),
            "Stock:",
            ...stocks.map((line) => `  ${line}`),
        ].join("\n");
        await ui.alert(player, { title: `${record.business.label} books`, content, confirmLabel: "Close" });
        return books;
    }

    async function manageRecord(player: Player, record: BusinessRecord): Promise<unknown> {
        const action = await ui.context(player, {
            title: record.business.label,
            description: `${record.shops.size} counter(s) · ${[...record.offers.values()].filter((offer) => offer.enabled).length} listed offer(s)`,
            options: [
                { id: "prices", title: "Prices", description: "Set what customers pay and what the shop pays staff." },
                { id: "restock", title: "Restock from inventory", description: "Put items you carry on the shelf." },
                { id: "withdraw", title: "Withdraw to inventory", description: "Take items off the shelf." },
                { id: "transfer", title: "Transfer stock", description: "Move stock between counters.", disabled: record.shops.size < 2 },
                { id: "add", title: "Add an offer", description: "List an item you can restock." },
                { id: "retire", title: "Retire or restore an offer", description: "Hide or show an offer without losing its history." },
                { id: "counters", title: "Counters", description: "Open or close, staffing policy, vendor body." },
                { id: "books", title: "Books", description: "Balance, today's sales and stock levels." },
            ],
            canClose: true,
        });
        switch (action) {
            case "prices": return pricesFlow(player, record);
            case "restock": return restockFlow(player, record);
            case "withdraw": return withdrawFlow(player, record);
            case "transfer": return transferFlow(player, record);
            case "add": return addOfferFlow(player, record);
            case "retire": return retireFlow(player, record);
            case "counters": return countersFlow(player, record);
            case "books": return booksFlow(player, record);
            default: return null;
        }
    }

    async function manage(player: Player, rawBusinessId?: string, trusted = false): Promise<unknown> {
        const owner = playerId(player);
        if (openMenus.has(owner)) return null;
        openMenus.add(owner);
        try {
            await start();
            if (!core.characters.active(player)) throw businessError("HMP_BUSINESS_CHARACTER", "Choose a character before managing a business.");
            let record: BusinessRecord | null = null;
            if (rawBusinessId) {
                record = recordOf(rawBusinessId);
                if (!trusted) await authorize(record, { actor: player });
            } else {
                const candidates = trusted ? [...records.values()].map((entry) => entry.business) : await managed(player);
                if (!candidates.length) { ui.notify(player, { description: "You do not manage any business.", tone: "warning" }); return null; }
                if (candidates.length === 1) record = records.get(candidates[0].id) || null;
                else {
                    const selected = await ui.context(player, { title: "Your businesses", options: candidates.map((business) => ({ id: business.id, title: business.label, description: `${records.get(business.id)?.shops.size || 0} counter(s)` })), canClose: true });
                    record = selected ? records.get(selected) || null : null;
                }
            }
            if (!record) return null;
            return await manageRecord(player, record);
        } catch (error) {
            logger.warn(`[hmp-business] management menu failed for #${owner}: ${messageOf(error)}`);
            ui.notify(player, { description: messageOf(error), tone: "error" });
            return null;
        } finally { openMenus.delete(owner); }
    }

    function disconnect(player: Player): boolean {
        const owner = playerId(player);
        openMenus.delete(owner);
        activeStock.delete(owner);
        return true;
    }

    async function stop(): Promise<void> {
        if (state === "stopped") return;
        state = "stopped";
        for (const record of records.values()) unpublishBusiness(record);
        disposeTreasury?.();
        disposeTreasury = null;
        records.clear();
        openMenus.clear();
        activeStock.clear();
        sales.clear();
    }

    return Object.freeze({
        businesses: Object.freeze({
            create: createBusiness,
            update: updateBusiness,
            remove: removeBusiness,
            get: (businessId: string) => records.get(String(businessId || "").trim())?.business || null,
            list: () => [...records.values()].map((record) => record.business),
            managed,
            sync,
        }),
        shops: Object.freeze({
            add: addShop,
            update: updateShop,
            remove: removeShop,
            get: (businessId: string, shopId: string) => records.get(String(businessId || "").trim())?.shops.get(String(shopId || "").trim()) || null,
            list: (businessId?: string) => [...records.values()].filter((record) => !businessId || record.business.id === businessId).flatMap((record) => [...record.shops.values()]),
            isStaffed: (businessId: string, shopId: string) => { const record = recordOf(businessId); return isStaffedNow(record, shopOf(record, shopId)); },
            shopId: (businessId: string, shopId: string) => shopKey(normalizeId(businessId, "business id"), normalizeId(shopId, "business shop id")),
        }),
        offers: Object.freeze({
            set: setOffer,
            setPrices,
            retire: (businessId: string, shopId: string, offerId: string, options?: Options) => setOfferEnabled(businessId, shopId, offerId, false, options),
            restore: (businessId: string, shopId: string, offerId: string, options?: Options) => setOfferEnabled(businessId, shopId, offerId, true, options),
            buybackPrice: (businessId: string, shopId: string, offerId: string) => { const target = stockTarget(businessId, shopId, offerId); return buybackPriceOf(target.record, target.offer) ?? null; },
            referenceValue: (item: string) => referenceValueOf(normalizeId(item, "item name")),
            get: (businessId: string, shopId: string, offerId: string) => records.get(String(businessId || "").trim())?.offers.get(offerKey(String(shopId || "").trim(), String(offerId || "").trim())) || null,
            list: (businessId: string, shopId?: string, includeRetired = false) => {
                const record = records.get(String(businessId || "").trim());
                if (!record) return [];
                return [...record.offers.values()].filter((offer) => (!shopId || offer.shopId === shopId) && (includeRetired || offer.enabled));
            },
        }),
        stock: Object.freeze({ get: getStock, set: setStock, restock, withdraw, transfer }),
        books: Object.freeze({ summary }),
        ui: Object.freeze({ manage: (player: Player, businessId?: string) => manage(player, businessId, false), close: (player: Player) => { openMenus.delete(playerId(player)); return ui.close(player, "Business menu closed"); } }),
        audit: Object.freeze({ history: (businessId: string, limit = 50) => repository.history(normalizeId(businessId, "business id"), integer(limit, 50, 1, 200)) }),
        status: () => ({
            state,
            lastError,
            businesses: records.size,
            shops: [...records.values()].reduce((total, record) => total + record.shops.size, 0),
            liveShops: [...records.values()].reduce((total, record) => total + record.live.size, 0),
            offers: [...records.values()].reduce((total, record) => total + record.offers.size, 0),
            openMenus: openMenus.size,
            uptimeMs: Math.max(0, now() - startedAt),
        }),
        start,
        seed,
        manageTrusted: (player: Player, businessId?: string) => manage(player, businessId, true),
        onDuty,
        onPurchased,
        onSold,
        onResourceStart,
        disconnect,
        stop,
    }) as BusinessService;
}

export = { createBusinessService, businessError, compactReference, parseShopKey };
