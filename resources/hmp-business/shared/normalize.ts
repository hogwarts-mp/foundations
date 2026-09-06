import type { HmpInteractionCharacter, HmpInteractVector3 } from "../../hmp-interact/types";
import type {
    HmpBusiness,
    HmpBusinessDefinition,
    HmpBusinessOffer,
    HmpBusinessOfferInput,
    HmpBusinessShop,
    HmpBusinessShopInput,
    HmpBusinessStaffing,
} from "../types";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const STAFFING = new Set<HmpBusinessStaffing>(["always", "staffed", "kiosk"]);
/** Business and counter ids are short so `business:<business>:<counter>` fits hmp-shops' 58-character shop id. */
const SHORT_ID = 24;

interface PriceBounds {
    floor: number;
    ceiling: number;
}

type BusinessValues = Omit<HmpBusiness, "createdAt" | "updatedAt">;

function clean(value: unknown, maximum = 120): string {
    return Array.from(String(value ?? ""), (character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127 ? " " : character;
    }).join("").replace(/\s+/g, " ").trim().slice(0, maximum);
}

function id(value: unknown, name: string, maximum = 64): string {
    const normalized = String(value ?? "").trim();
    if (!ID.test(normalized) || normalized.length > maximum) throw new TypeError(`${name} is invalid`);
    return normalized;
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
    const numeric = Number(value);
    return Math.trunc(Math.min(maximum, Math.max(minimum, Number.isFinite(numeric) ? numeric : fallback)));
}

function positiveId(value: unknown, name: string): number {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < 1) throw new TypeError(`${name} is invalid`);
    return numeric;
}

function vector(raw: unknown, name: string): HmpInteractVector3 {
    const value = raw as Partial<HmpInteractVector3> | null | undefined;
    const position = Object.freeze({ x: Number(value?.x), y: Number(value?.y), z: Number(value?.z) });
    if (!Object.values(position).every(Number.isFinite)) throw new TypeError(`${name} needs a finite position`);
    return position;
}

function price(value: unknown, name: string, bounds: PriceBounds): number | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new TypeError(`${name} must be a number`);
    const rounded = Math.trunc(numeric);
    if (rounded < bounds.floor || rounded > bounds.ceiling) throw new TypeError(`${name} must be between ${bounds.floor} and ${bounds.ceiling}`);
    return rounded;
}

/** A buyback share in 0..1 with three decimals; empty means the offer is never bought back. */
function ratio(value: unknown, name: string): number | null {
    if (value === undefined || value === null || value === "") return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) throw new TypeError(`${name} must be between 0 and 1`);
    const rounded = Math.round(numeric * 1000) / 1000;
    return rounded > 0 ? rounded : null;
}

function staffing(value: unknown): HmpBusinessStaffing {
    const normalized = String(value ?? "always").trim().toLowerCase() as HmpBusinessStaffing;
    if (!STAFFING.has(normalized)) throw new TypeError(`staffing policy '${String(value)}' is invalid`);
    return normalized;
}

function vendor(raw: unknown): HmpInteractionCharacter | null {
    if (raw === null || raw === undefined || raw === false) return null;
    if (typeof raw !== "object") throw new TypeError("vendor must be an object or null");
    const value = raw as Partial<HmpInteractionCharacter>;
    const yaw = value.yaw === undefined || value.yaw === null ? undefined : Number(value.yaw);
    if (yaw !== undefined && !Number.isFinite(yaw)) throw new TypeError("vendor yaw must be finite");
    return Object.freeze({
        characterId: id(value.characterId, "vendor character id"),
        yaw,
        label: clean(value.label, 80) || undefined,
    });
}

/** The hmp-shops shop id a counter registers under. */
function shopKey(businessId: string, shopId: string): string {
    return `business:${businessId}:${shopId}`;
}

function normalizeBusiness(raw: HmpBusinessDefinition): BusinessValues {
    if (!raw || typeof raw !== "object") throw new TypeError("business definition is required");
    const businessId = id(raw.id, "business id", SHORT_ID);
    return Object.freeze({
        id: businessId,
        jobId: id(raw.jobId, "business job id"),
        label: clean(raw.label, 80) || businessId,
        currency: id(raw.currency || "galleons", "business currency"),
        enabled: raw.enabled !== false,
    });
}

function normalizeShop(businessId: string, raw: HmpBusinessShopInput): HmpBusinessShop {
    if (!raw || typeof raw !== "object") throw new TypeError("business shop is required");
    const shopId = id(raw.id, "business shop id", SHORT_ID);
    const radius = integer(raw.radius, 300, 25, 10000);
    return Object.freeze({
        businessId: id(businessId, "business id", SHORT_ID),
        id: shopId,
        label: clean(raw.label, 80) || shopId,
        description: clean(raw.description, 180) || undefined,
        position: vector(raw.position, `business shop '${shopId}'`),
        areaId: clean(raw.areaId, 128) || undefined,
        regionId: clean(raw.regionId, 128) || undefined,
        radius,
        staffRadius: integer(raw.staffRadius, Math.max(1000, radius), 25, 50000),
        dutyPoint: raw.dutyPoint === null || raw.dutyPoint === undefined ? null : vector(raw.dutyPoint, `business shop '${shopId}' duty point`),
        vendor: vendor(raw.vendor),
        staffing: staffing(raw.staffing),
        enabled: raw.enabled !== false,
    });
}

function normalizeOffer(businessId: string, shopId: string, raw: HmpBusinessOfferInput, bounds: PriceBounds): { offer: HmpBusinessOffer; stock: number | null } {
    if (!raw || typeof raw !== "object") throw new TypeError("business offer is required");
    const offerId = id(raw.id, "business offer id");
    const buyPrice = price(raw.buyPrice, `offer '${offerId}' buy price`, bounds);
    const sellPrice = price(raw.sellPrice, `offer '${offerId}' sell price`, bounds);
    if (buyPrice === undefined && sellPrice === undefined) throw new TypeError(`offer '${offerId}' needs a buy price or a sell price`);
    if (buyPrice !== undefined && sellPrice !== undefined) throw new TypeError(`offer '${offerId}' cannot carry a sell price beside a buy price; buybacks derive from buybackRatio`);
    const buybackRatio = ratio(raw.buybackRatio, `offer '${offerId}' buyback ratio`);
    const unlimited = raw.unlimited === true;
    return {
        offer: Object.freeze({
            businessId: id(businessId, "business id", SHORT_ID),
            shopId: id(shopId, "business shop id", SHORT_ID),
            id: offerId,
            item: id(raw.item, `offer '${offerId}' item`),
            label: clean(raw.label, 80) || undefined,
            buyPrice,
            sellPrice,
            buybackRatio,
            maxQuantity: integer(raw.maxQuantity, 99, 1, 1000000),
            unlimited,
            enabled: raw.enabled !== false,
        }),
        stock: unlimited || raw.stock === undefined || raw.stock === null ? null : integer(raw.stock, 0, 0, 2147483647),
    };
}

export = { clean, id, integer, positiveId, vector, price, ratio, staffing, vendor, shopKey, normalizeBusiness, normalizeShop, normalizeOffer, SHORT_ID };
