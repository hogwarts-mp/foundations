import type { HmpBusiness, HmpBusinessOfferInput, HmpBusinessShopInput, HmpBusinessMutationOptions } from "../types";
import type { AdminGroup, Banking, BusinessService, Core, Inventory, Jobs, Logger, Player, PriceConfig } from "./internal";

interface ScreenDependencies {
    service: BusinessService;
    core: Core;
    inventory: Inventory;
    banking: Banking;
    jobs: Jobs;
    prices: PriceConfig;
    adminGroups: AdminGroup[];
    logger: Logger;
}

type Payload = Record<string, unknown>;

const clean = (value: unknown, limit = 191): string => String(value ?? "").trim().slice(0, limit);
const number = (value: unknown, fallback = 0): number => Number.isFinite(Number(value)) ? Number(value) : fallback;
const boolean = (value: unknown): boolean => value === true || value === "true" || value === 1 || value === "1";
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

function createBusinessScreen(dependencies: ScreenDependencies) {
    const { service, core, inventory, banking, jobs, prices, adminGroups, logger } = dependencies;
    const open = new Map<number, string | null>();

    async function isAdmin(player: Player): Promise<boolean> {
        if (!adminGroups.length) return false;
        const grants = await Promise.all(adminGroups.map((group) => core.groups.has(player, group.key, group.minimumGrade)));
        return grants.some(Boolean);
    }

    function actor(player: Player, admin: boolean, reason: unknown): HmpBusinessMutationOptions<Player> {
        return { actor: player, ...(admin ? { admin: true as const } : {}), reason: clean(reason) || "Business console" };
    }

    function location(player: Player) {
        const position = player.position;
        if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) throw new Error("Your position is not available yet.");
        const place = typeof player.location === "function" ? player.location() : null;
        return {
            position: { x: position.x, y: position.y, z: position.z },
            areaId: place?.areaId || undefined,
            regionId: place?.regionId || undefined,
        };
    }

    async function accessible(player: Player, admin: boolean): Promise<HmpBusiness[]> {
        return admin ? service.businesses.list() : service.businesses.managed(player);
    }

    async function selected(player: Player, requested?: unknown): Promise<{ business: HmpBusiness | null; admin: boolean; businesses: HmpBusiness[] }> {
        const admin = await isAdmin(player);
        const businesses = await accessible(player, admin);
        const wanted = clean(requested || open.get(player.id), 32);
        const business = businesses.find((entry) => entry.id === wanted) || businesses[0] || null;
        open.set(player.id, business?.id || null);
        return { business, admin, businesses };
    }

    async function buildModel(player: Player, requested?: unknown) {
        await service.start();
        if (!core.characters.active(player)) throw new Error("Choose a character before managing a business.");
        const access = await selected(player, requested);
        const selectedCurrency = access.business ? banking.currencies.get(access.business.currency) : null;
        const base = {
            admin: access.admin,
            businesses: access.businesses.map((business) => ({ id: business.id, label: business.label, enabled: business.enabled })),
            selectedBusinessId: access.business?.id || null,
            business: access.business,
            shops: [] as unknown[], offers: [] as unknown[], staff: [] as unknown[], audit: [] as unknown[],
            books: null as unknown, job: null as unknown,
            currency: selectedCurrency ? { id: selectedCurrency.id, label: selectedCurrency.label, symbol: selectedCurrency.symbol || "" } : null,
            items: inventory.items.list().map((item) => ({ name: item.name, label: item.label || item.nativeId || item.name, category: item.category || "Other", referenceValue: item.referenceValue ?? null })),
            jobs: access.admin ? jobs.jobs.list().map((job) => ({ id: job.id, label: job.label, organizationId: job.banking && job.banking.organizationId || null, currency: job.banking && job.banking.currency || null })) : [],
            currencies: access.admin ? banking.currencies.list().map((currency) => ({ id: currency.id, label: currency.label, symbol: currency.symbol || "" })) : [],
            bounds: access.business ? { floor: prices.floor, ceiling: prices.ceilings[access.business.currency] ?? prices.ceiling, buybacks: prices.buybacks } : { floor: prices.floor, ceiling: prices.ceiling, buybacks: prices.buybacks },
        };
        if (!access.business) return base;

        const business = access.business;
        const option = actor(player, access.admin, "Business console view");
        const shops = service.shops.list(business.id);
        const offers = service.offers.list(business.id, undefined, true);
        const stock = await Promise.all(offers.map((offer) => offer.unlimited ? Promise.resolve(null) : service.stock.get(business.id, offer.shopId, offer.id)));
        const job = jobs.jobs.get(business.jobId);
        const employments = await jobs.employment.employees(business.jobId);
        const duty = new Map(jobs.duty.list(business.jobId).map((entry) => [entry.characterId, entry]));
        return {
            ...base,
            shops: shops.map((shop) => ({ ...shop, staffed: service.shops.isStaffed(business.id, shop.id) })),
            offers: offers.map((offer, index) => ({ ...offer, stock: stock[index], buybackPrice: service.offers.buybackPrice(business.id, offer.shopId, offer.id) })),
            books: await service.books.summary(business.id, option),
            audit: await service.audit.history(business.id, 50),
            job: job ? { id: job.id, label: job.label, grades: job.grades } : null,
            staff: employments.map((employment) => ({
                ...employment,
                gradeLabel: job?.grades.find((grade) => grade.level === employment.grade)?.label || `Grade ${employment.grade}`,
                salary: job?.grades.find((grade) => grade.level === employment.grade)?.salary ?? null,
                permissions: [...new Set(job?.grades.filter((grade) => grade.level <= employment.grade).flatMap((grade) => grade.permissions || []) || [])],
                duty: duty.get(employment.characterId) || null,
            })),
        };
    }

    async function push(player: Player, event = "hmp-business:model", requested?: unknown): Promise<boolean> {
        if (!open.has(player.id) && event !== "hmp-business:open") return false;
        const model = await buildModel(player, requested);
        player.emit(event, JSON.stringify(model));
        return true;
    }

    async function show(player: Player, businessId?: string): Promise<boolean> {
        open.set(player.id, clean(businessId, 32) || null);
        try { return await push(player, "hmp-business:open", businessId); }
        catch (error) { open.delete(player.id); throw error; }
    }

    function hide(player: Player): boolean {
        const existed = open.delete(player.id);
        player.emit("hmp-business:close", "{}");
        return existed;
    }

    async function requireTarget(player: Player, payload: Payload) {
        const access = await selected(player, payload.businessId);
        if (!access.business) throw new Error(access.admin ? "Create a business first." : "You do not manage any business.");
        return access;
    }

    async function perform(player: Player, raw: unknown): Promise<boolean> {
        if (!open.has(player.id)) return false;
        const payload = raw && typeof raw === "object" ? raw as Payload : {};
        const action = clean(payload.action, 40);
        try {
            if (action === "select") { await push(player, "hmp-business:model", payload.businessId); return true; }
            if (action === "refresh") { await push(player); return true; }
            if (action === "create-business") {
                if (!await isAdmin(player)) throw new Error("Only an administrator can create a business.");
                const created = await service.businesses.create({ id: clean(payload.id, 32), jobId: clean(payload.jobId, 64), label: clean(payload.label, 80), currency: clean(payload.currency, 32) || "galleons" }, actor(player, true, payload.reason));
                open.set(player.id, created.id);
                await push(player);
                return true;
            }
            const access = await requireTarget(player, payload);
            const business = access.business!;
            const options = actor(player, access.admin, payload.reason);
            const shopId = clean(payload.shopId, 32);
            const offerId = clean(payload.offerId, 64);

            switch (action) {
                case "update-business":
                    await service.businesses.update(business.id, { label: clean(payload.label, 80) || business.label, ...(access.admin ? { currency: clean(payload.currency, 32) || business.currency, enabled: boolean(payload.enabled) } : {}) }, options);
                    break;
                case "remove-business":
                    if (!access.admin) throw new Error("Only an administrator can remove a business.");
                    await service.businesses.remove(business.id, options);
                    open.set(player.id, null);
                    break;
                case "place-shop": {
                    if (!access.admin) throw new Error("Only an administrator can place a counter.");
                    const here = location(player);
                    const shop: HmpBusinessShopInput = {
                        id: clean(payload.id, 32), label: clean(payload.label, 80), description: clean(payload.description, 191) || undefined,
                        ...here, radius: number(payload.radius, 180), staffRadius: number(payload.staffRadius, 1000),
                        staffing: clean(payload.staffing) as HmpBusinessShopInput["staffing"], dutyPoint: boolean(payload.dutyPoint) ? here.position : null,
                    };
                    await service.shops.add(business.id, shop, options);
                    break;
                }
                case "update-shop": {
                    const current = service.shops.get(business.id, shopId);
                    if (!current) throw new Error("That counter no longer exists.");
                    const characterId = clean(payload.vendorCharacterId, 64);
                    await service.shops.update(business.id, shopId, {
                        label: clean(payload.label, 80) || current.label,
                        description: clean(payload.description, 191) || undefined,
                        staffing: clean(payload.staffing) as HmpBusinessShopInput["staffing"],
                        enabled: boolean(payload.enabled),
                        staffRadius: number(payload.staffRadius, current.staffRadius),
                        ...(access.admin ? { radius: number(payload.radius, current.radius) } : {}),
                        vendor: characterId ? { characterId, yaw: number(payload.vendorYaw), label: clean(payload.vendorLabel, 80) || undefined } : null,
                    }, options);
                    break;
                }
                case "move-shop": {
                    if (!access.admin) throw new Error("Only an administrator can move a counter.");
                    await service.shops.update(business.id, shopId, location(player), options);
                    break;
                }
                case "duty-point": {
                    if (!access.admin) throw new Error("Only an administrator can place a clock-in point.");
                    await service.shops.update(business.id, shopId, { dutyPoint: boolean(payload.clear) ? null : location(player).position }, options);
                    break;
                }
                case "remove-shop":
                    if (!access.admin) throw new Error("Only an administrator can remove a counter.");
                    await service.shops.remove(business.id, shopId, options);
                    break;
                case "set-offer": {
                    const current = offerId ? service.offers.get(business.id, shopId, offerId) : null;
                    const item = clean(payload.item || current?.item, 64);
                    const input: HmpBusinessOfferInput = {
                        ...(current || {}), id: offerId || clean(payload.id || item, 64), item,
                        label: clean(payload.label, 80) || undefined,
                        buyPrice: payload.buyPrice === "" || payload.buyPrice === null ? null : number(payload.buyPrice),
                        buybackRatio: payload.buybackRatio === "" || payload.buybackRatio === null ? null : number(payload.buybackRatio),
                        maxQuantity: number(payload.maxQuantity, current?.maxQuantity || 10),
                        unlimited: access.admin && boolean(payload.unlimited), enabled: payload.enabled === undefined ? true : boolean(payload.enabled),
                        ...(!current && access.admin && payload.stock !== undefined ? { stock: number(payload.stock) } : {}),
                    };
                    await service.offers.set(business.id, shopId, input, options);
                    break;
                }
                case "toggle-offer": {
                    const current = service.offers.get(business.id, shopId, offerId);
                    if (!current) throw new Error("That offer no longer exists.");
                    if (current.enabled) await service.offers.retire(business.id, shopId, offerId, options);
                    else await service.offers.restore(business.id, shopId, offerId, options);
                    break;
                }
                case "restock": await service.stock.restock(player, business.id, shopId, offerId, number(payload.quantity), options); break;
                case "withdraw": await service.stock.withdraw(player, business.id, shopId, offerId, number(payload.quantity), options); break;
                case "transfer": await service.stock.transfer(business.id, shopId, clean(payload.toShopId, 32), offerId, number(payload.quantity), options); break;
                case "set-stock":
                    if (!access.admin) throw new Error("Only an administrator can set shelf stock directly.");
                    await service.stock.set(business.id, shopId, offerId, number(payload.quantity), options);
                    break;
                case "manage-staff":
                    player.emit("hmp-business:close", "{}");
                    await jobs.ui.manage(player, business.jobId);
                    await push(player, "hmp-business:open", business.id);
                    return true;
                default: throw new Error("That business action is not supported.");
            }
            await push(player);
            return true;
        } catch (error) {
            logger.warn(`[hmp-business] screen action '${action}' failed for #${player.id}: ${messageOf(error)}`);
            player.emit("hmp-business:error", JSON.stringify({ message: messageOf(error) }));
            return false;
        }
    }

    async function refreshAll(): Promise<void> {
        await Promise.all([...open.keys()].map(async (id) => {
            const player = PlayerManager.getById(id) as Player | null;
            if (!player) { open.delete(id); return; }
            try { await push(player); } catch (_) { /* the next explicit refresh reports the problem */ }
        }));
    }

    return Object.freeze({ show, hide, perform, refresh: (player: Player) => push(player), refreshAll, disconnect: (player: Player) => open.delete(player.id), status: () => ({ open: open.size }) });
}

export = { createBusinessScreen };
