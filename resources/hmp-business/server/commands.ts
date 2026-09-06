import normalizeModule = require("../shared/normalize");
import type { HmpCommandContext, HmpCommandRouter } from "../../hmp-lib/types";
import type { HmpBusinessOffer, HmpBusinessShop } from "../types";
import type { BusinessService, CommandConfig, Core, Logger, Player } from "./internal";

const { clean, integer, staffing: normalizeStaffing } = normalizeModule;

type Context = HmpCommandContext<Player>;

interface CommandDependencies {
    router: HmpCommandRouter<Player>;
    service: BusinessService;
    core: Core;
    config: CommandConfig;
    logger: Logger;
    open: (player: Player, businessId?: string) => Promise<unknown>;
}

const USAGE = [
    "list | audit <business> [limit] | sync",
    "create <business> <job> [label…] | remove <business>",
    "shop <business> <counter> [label…]  (placed where you stand)",
    "dutypoint <business> <counter> [clear]  (placed where you stand)",
    "vendor <business> <counter> <characterId|none> [yaw] [label…]",
    "staffing <business> <counter> <always|staffed|kiosk>",
    "open <business> <counter> | close <business> <counter>",
    "offer <business> <counter> <item> <buy|-> [buyback|-] [max] [offerId]  (buyback is a 0..1 share of the reference value, or the raw price when buy is -)",
    "retire <business> <counter> <offer> | restore <business> <counter> <offer>",
    "stock <business> <counter> <offer> <quantity>",
    "manage [business]",
];

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function optionalPrice(raw: string | undefined): number | null | undefined {
    if (raw === undefined) return undefined;
    if (raw === "-" || raw === "none" || raw === "") return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new TypeError(`price '${raw}' is not a number`);
    return value;
}

function describeShop(shop: HmpBusinessShop, staffed: boolean): string {
    return `  ${shop.id} · ${shop.label} · ${shop.enabled ? (staffed ? "open, staffed" : "open") : "closed"} · ${shop.staffing}${shop.vendor ? ` · vendor ${shop.vendor.characterId}` : ""}${shop.dutyPoint ? " · clock-in" : ""}`;
}

function describeOffer(offer: HmpBusinessOffer, stock: number | null, buyback: number | null): string {
    return `    ${offer.id} · ${offer.item} · buy ${offer.buyPrice ?? "-"} · buyback ${buyback ?? "-"}${offer.buybackRatio ? ` (share ${offer.buybackRatio})` : ""} · max ${offer.maxQuantity} · stock ${offer.unlimited ? "∞" : stock ?? 0}${offer.enabled ? "" : " · retired"}`;
}

function registerCommands(dependencies: CommandDependencies): () => boolean {
    const { router, service, core, config, logger, open } = dependencies;

    async function isAdmin(player: Player): Promise<boolean> {
        if (!config.adminGroups.length) return false;
        const results = await Promise.all(config.adminGroups.map((group) => core.groups.has(player, group.key, group.minimumGrade)));
        return results.some(Boolean);
    }

    function actorOptions(context: Context, reason: string) {
        return { actor: context.player, admin: true as const, reason: clean(reason, 191) || `/${config.command} by ${context.player.nickname || context.player.id}` };
    }

    function here(context: Context) {
        const position = context.player.position;
        if (!position || ![position.x, position.y, position.z].every(Number.isFinite)) throw new Error("Your position is not available yet.");
        const location = typeof context.player.location === "function" ? context.player.location() : null;
        return { position: { x: position.x, y: position.y, z: position.z }, areaId: location?.areaId || undefined, regionId: location?.regionId || undefined };
    }

    async function list(context: Context): Promise<void> {
        const businesses = service.businesses.list();
        if (!businesses.length) { context.reply("No businesses exist. Create one with /business create <id> <job> [label]."); return; }
        for (const business of businesses) {
            context.reply(`${business.id} · ${business.label} · job ${business.jobId} · ${business.currency}${business.enabled ? "" : " · disabled"}`);
            for (const shop of service.shops.list(business.id)) {
                context.reply(describeShop(shop, service.shops.isStaffed(business.id, shop.id)));
                for (const offer of service.offers.list(business.id, shop.id, true)) {
                    context.reply(describeOffer(offer, offer.unlimited ? null : await service.stock.get(business.id, shop.id, offer.id), service.offers.buybackPrice(business.id, shop.id, offer.id)));
                }
            }
        }
    }

    async function run(context: Context): Promise<unknown> {
        if (!context.args.length) return open(context.player);
        const [action = "help", ...rest] = context.args;
        const options = (reason = "") => actorOptions(context, reason);
        switch (action.toLowerCase()) {
            case "list": return list(context);
            case "sync": {
                const live = await service.businesses.sync();
                return context.reply(`Re-registered ${live} live counter(s).`);
            }
            case "audit": {
                const [businessId, limit] = rest;
                if (!businessId) return context.reply("Usage: /business audit <business> [limit]");
                const entries = await service.audit.history(businessId, integer(limit, 20, 1, 50));
                if (!entries.length) return context.reply("No ledger entries.");
                for (const entry of entries) context.reply(`#${entry.id} ${entry.action} ${entry.shopId || ""}${entry.offerId ? `/${entry.offerId}` : ""} by ${entry.actorCharacterId ?? "system"}${entry.reason ? ` · ${entry.reason}` : ""}${entry.after ? ` · ${JSON.stringify(entry.after)}` : ""}`);
                return entries.length;
            }
            case "create": {
                const [businessId, jobId, ...label] = rest;
                if (!businessId || !jobId) return context.reply("Usage: /business create <business> <job> [label…]");
                const business = await service.businesses.create({ id: businessId, jobId, label: label.join(" ") }, options());
                return context.reply(`Created business '${business.id}' (${business.label}) bound to job '${business.jobId}'. Add a counter with /business shop.`);
            }
            case "remove": {
                const [businessId] = rest;
                if (!businessId) return context.reply("Usage: /business remove <business>");
                await service.businesses.remove(businessId, options());
                return context.reply(`Removed business '${businessId}'. Its stock rows remain in hmp-shops.`);
            }
            case "shop": {
                const [businessId, shopId, ...label] = rest;
                if (!businessId || !shopId) return context.reply("Usage: /business shop <business> <counter> [label…]");
                const placement = here(context);
                const shop = await service.shops.add(businessId, { id: shopId, label: label.join(" "), ...placement }, options());
                return context.reply(`Placed counter '${shop.id}' at ${shop.position.x.toFixed(1)}, ${shop.position.y.toFixed(1)}, ${shop.position.z.toFixed(1)}${shop.areaId ? ` in ${shop.areaId}` : ""}. Add offers with /business offer.`);
            }
            case "dutypoint": {
                const [businessId, shopId, mode] = rest;
                if (!businessId || !shopId) return context.reply("Usage: /business dutypoint <business> <counter> [clear]");
                const dutyPoint = mode === "clear" ? null : here(context).position;
                const shop = await service.shops.update(businessId, shopId, { dutyPoint }, options());
                return context.reply(shop.dutyPoint ? `Clock-in zone for '${shop.id}' placed where you stand.` : `Clock-in zone for '${shop.id}' removed.`);
            }
            case "vendor": {
                const [businessId, shopId, characterId, yaw, ...label] = rest;
                if (!businessId || !shopId || !characterId) return context.reply("Usage: /business vendor <business> <counter> <characterId|none> [yaw] [label…]");
                const vendor = characterId === "none" ? null : { characterId, yaw: yaw === undefined ? undefined : Number(yaw), label: label.join(" ") || undefined };
                const shop = await service.shops.update(businessId, shopId, { vendor }, options());
                return context.reply(shop.vendor ? `'${shop.id}' is minded by ${shop.vendor.characterId} while nobody is on duty.` : `'${shop.id}' has no vendor body.`);
            }
            case "staffing": {
                const [businessId, shopId, policy] = rest;
                if (!businessId || !shopId || !policy) return context.reply("Usage: /business staffing <business> <counter> <always|staffed|kiosk>");
                const shop = await service.shops.update(businessId, shopId, { staffing: normalizeStaffing(policy) }, options());
                return context.reply(`'${shop.id}' staffing is now ${shop.staffing}.`);
            }
            case "open":
            case "close": {
                const [businessId, shopId] = rest;
                if (!businessId || !shopId) return context.reply(`Usage: /business ${action} <business> <counter>`);
                const shop = await service.shops.update(businessId, shopId, { enabled: action === "open" }, options());
                return context.reply(`'${shop.id}' is now ${shop.enabled ? "open" : "closed"}.`);
            }
            case "offer": {
                const [businessId, shopId, item, buy, buyback, max, offerId] = rest;
                if (!businessId || !shopId || !item || buy === undefined) return context.reply("Usage: /business offer <business> <counter> <item> <buy|-> [buyback|-] [max] [offerId]");
                const buyPrice = optionalPrice(buy);
                const sellOnly = buyPrice === null;
                const offer = await service.offers.set(businessId, shopId, {
                    id: offerId || item, item, buyPrice,
                    sellPrice: sellOnly ? optionalPrice(buyback) : null,
                    buybackRatio: sellOnly ? null : optionalPrice(buyback),
                    maxQuantity: max === undefined ? undefined : Number(max),
                }, options());
                const paid = service.offers.buybackPrice(businessId, shopId, offer.id);
                return context.reply(`Offer '${offer.id}' at '${shopId}': ${offer.item}, buy ${offer.buyPrice ?? "-"}, buyback ${paid ?? "-"}${offer.buybackRatio ? ` (share ${offer.buybackRatio})` : ""}, max ${offer.maxQuantity}. Seed stock with /business stock.`);
            }
            case "retire":
            case "restore": {
                const [businessId, shopId, offerId] = rest;
                if (!businessId || !shopId || !offerId) return context.reply(`Usage: /business ${action} <business> <counter> <offer>`);
                const offer = action === "retire" ? await service.offers.retire(businessId, shopId, offerId, options()) : await service.offers.restore(businessId, shopId, offerId, options());
                return context.reply(`Offer '${offer.id}' is now ${offer.enabled ? "listed" : "retired"}.`);
            }
            case "stock": {
                const [businessId, shopId, offerId, quantity] = rest;
                if (!businessId || !shopId || !offerId || quantity === undefined) return context.reply("Usage: /business stock <business> <counter> <offer> <quantity>");
                const stock = await service.stock.set(businessId, shopId, offerId, Number(quantity), options());
                return context.reply(`'${shopId}' now holds ${stock} × '${offerId}'.`);
            }
            case "manage": {
                const [businessId] = rest;
                return open(context.player, businessId);
            }
            default:
                context.reply(`Usage: /${config.command} <action>`);
                for (const line of USAGE) context.reply(`  ${line}`);
                return null;
        }
    }

    return router.register(config.command, {
        description: "Open the business console; administrators may also use command fallbacks.",
        usage: `/${config.command} [action …]`,
        guard: async ({ player, args }) => {
            const action = String(args[0] || "").toLowerCase();
            if (!action || action === "manage") {
                if (await isAdmin(player)) return true;
                return (await service.businesses.managed(player)).length > 0 || "You do not manage any business.";
            }
            return (await isAdmin(player)) || "You are not allowed to administer businesses.";
        },
    }, async (context) => {
        try { await run(context); }
        catch (error) {
            logger.warn(`[hmp-business] /${config.command} ${context.args.join(" ")} failed for #${context.player.id}: ${messageOf(error)}`);
            context.reply(messageOf(error));
        }
    });
}

export = { registerCommands, USAGE };
