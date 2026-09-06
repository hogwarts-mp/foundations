import type { HmpMySQLMigration } from "../../hmp-mysql/types";

import type { HmpBusiness, HmpBusinessAuditEntry, HmpBusinessOffer, HmpBusinessShop, HmpBusinessStaffing } from "../types";
import type { AuditDraft, BusinessRepository, BusinessValues, Database } from "./internal";

interface BusinessRow {
    id: string;
    job_id: string;
    label: string;
    currency_id: string;
    enabled: number | string | boolean;
    created_at: string | Date;
    updated_at: string | Date;
}

interface ShopRow {
    business_id: string;
    id: string;
    label: string;
    description: string;
    position_x: number | string;
    position_y: number | string;
    position_z: number | string;
    area_id: string | null;
    region_id: string | null;
    radius: number | string;
    staff_radius: number | string;
    duty_x: number | string | null;
    duty_y: number | string | null;
    duty_z: number | string | null;
    vendor_character_id: string | null;
    vendor_yaw: number | string | null;
    vendor_label: string | null;
    staffing: HmpBusinessStaffing;
    enabled: number | string | boolean;
}

interface OfferRow {
    business_id: string;
    shop_id: string;
    id: string;
    item_name: string;
    label: string | null;
    buy_price: number | string | null;
    sell_price: number | string | null;
    max_quantity: number | string;
    unlimited: number | string | boolean;
    enabled: number | string | boolean;
}

interface AuditRow {
    id: number | string;
    business_id: string;
    shop_id: string | null;
    offer_id: string | null;
    action: string;
    actor_character_id: number | string | null;
    before_json: string | null;
    after_json: string | null;
    reason: string;
    created_at: string | Date;
}

const flag = (value: number | string | boolean): boolean => value === true || Number(value) === 1;
const optionalNumber = (value: number | string | null | undefined): number | undefined => value === null || value === undefined ? undefined : Number(value);

function parseJson(value: string | null): Record<string, unknown> | null {
    if (!value) return null;
    try {
        const parsed: unknown = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch { return null; }
}

function mapBusiness(row: BusinessRow): HmpBusiness {
    return Object.freeze({
        id: row.id,
        jobId: row.job_id,
        label: row.label,
        currency: row.currency_id,
        enabled: flag(row.enabled),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
}

function mapShop(row: ShopRow): HmpBusinessShop {
    const dutyPoint = row.duty_x === null || row.duty_y === null || row.duty_z === null
        ? null
        : Object.freeze({ x: Number(row.duty_x), y: Number(row.duty_y), z: Number(row.duty_z) });
    return Object.freeze({
        businessId: row.business_id,
        id: row.id,
        label: row.label,
        description: row.description || undefined,
        position: Object.freeze({ x: Number(row.position_x), y: Number(row.position_y), z: Number(row.position_z) }),
        areaId: row.area_id || undefined,
        regionId: row.region_id || undefined,
        radius: Number(row.radius),
        staffRadius: Number(row.staff_radius),
        dutyPoint,
        vendor: row.vendor_character_id ? Object.freeze({ characterId: row.vendor_character_id, yaw: optionalNumber(row.vendor_yaw), label: row.vendor_label || undefined }) : null,
        staffing: row.staffing,
        enabled: flag(row.enabled),
    });
}

function mapOffer(row: OfferRow): HmpBusinessOffer {
    return Object.freeze({
        businessId: row.business_id,
        shopId: row.shop_id,
        id: row.id,
        item: row.item_name,
        label: row.label || undefined,
        buyPrice: optionalNumber(row.buy_price),
        sellPrice: optionalNumber(row.sell_price),
        maxQuantity: Number(row.max_quantity),
        unlimited: flag(row.unlimited),
        enabled: flag(row.enabled),
    });
}

function mapAudit(row: AuditRow): HmpBusinessAuditEntry {
    return Object.freeze({
        id: Number(row.id),
        businessId: row.business_id,
        shopId: row.shop_id,
        offerId: row.offer_id,
        action: row.action,
        actorCharacterId: row.actor_character_id === null ? null : Number(row.actor_character_id),
        before: parseJson(row.before_json),
        after: parseJson(row.after_json),
        reason: row.reason || "",
        createdAt: row.created_at,
    });
}

function createRepository(database: Database): BusinessRepository {
    if (!database || typeof database.transaction !== "function") throw new TypeError("database API is required");

    async function getBusiness(id: string): Promise<HmpBusiness> {
        const row = await database.single<BusinessRow>("SELECT * FROM hmp_business WHERE id = ?", [id]);
        if (!row) throw new Error(`business '${id}' was not found`);
        return mapBusiness(row);
    }

    async function loadAll() {
        const [businesses, shops, offers] = await Promise.all([
            database.query<BusinessRow[]>("SELECT * FROM hmp_business ORDER BY id"),
            database.query<ShopRow[]>("SELECT * FROM hmp_business_shop ORDER BY business_id, id"),
            database.query<OfferRow[]>("SELECT * FROM hmp_business_offer ORDER BY business_id, shop_id, id"),
        ]);
        return { businesses: businesses.map(mapBusiness), shops: shops.map(mapShop), offers: offers.map(mapOffer) };
    }

    async function createBusiness(values: BusinessValues): Promise<HmpBusiness | null> {
        const created = await database.update(
            "INSERT IGNORE INTO hmp_business (id, job_id, label, currency_id, enabled) VALUES (?, ?, ?, ?, ?)",
            [values.id, values.jobId, values.label, values.currency, values.enabled ? 1 : 0],
        );
        return created > 0 ? getBusiness(values.id) : null;
    }

    async function updateBusiness(values: BusinessValues): Promise<HmpBusiness> {
        await database.update(
            "UPDATE hmp_business SET job_id = ?, label = ?, currency_id = ?, enabled = ? WHERE id = ?",
            [values.jobId, values.label, values.currency, values.enabled ? 1 : 0, values.id],
        );
        return getBusiness(values.id);
    }

    async function deleteBusiness(id: string): Promise<boolean> {
        return (await database.update("DELETE FROM hmp_business WHERE id = ?", [id])) > 0;
    }

    async function saveShop(shop: HmpBusinessShop): Promise<void> {
        await database.update(
            `INSERT INTO hmp_business_shop
                (business_id, id, label, description, position_x, position_y, position_z, area_id, region_id, radius, staff_radius,
                 duty_x, duty_y, duty_z, vendor_character_id, vendor_yaw, vendor_label, staffing, enabled)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                label = VALUES(label), description = VALUES(description),
                position_x = VALUES(position_x), position_y = VALUES(position_y), position_z = VALUES(position_z),
                area_id = VALUES(area_id), region_id = VALUES(region_id), radius = VALUES(radius), staff_radius = VALUES(staff_radius),
                duty_x = VALUES(duty_x), duty_y = VALUES(duty_y), duty_z = VALUES(duty_z),
                vendor_character_id = VALUES(vendor_character_id), vendor_yaw = VALUES(vendor_yaw), vendor_label = VALUES(vendor_label),
                staffing = VALUES(staffing), enabled = VALUES(enabled)`,
            [
                shop.businessId, shop.id, shop.label, shop.description || "",
                shop.position.x, shop.position.y, shop.position.z, shop.areaId || null, shop.regionId || null, shop.radius, shop.staffRadius,
                shop.dutyPoint?.x ?? null, shop.dutyPoint?.y ?? null, shop.dutyPoint?.z ?? null,
                shop.vendor?.characterId || null, shop.vendor?.yaw ?? null, shop.vendor?.label || null,
                shop.staffing, shop.enabled ? 1 : 0,
            ],
        );
    }

    async function deleteShop(businessId: string, shopId: string): Promise<boolean> {
        return (await database.update("DELETE FROM hmp_business_shop WHERE business_id = ? AND id = ?", [businessId, shopId])) > 0;
    }

    async function saveOffer(offer: HmpBusinessOffer): Promise<void> {
        await database.update(
            `INSERT INTO hmp_business_offer
                (business_id, shop_id, id, item_name, label, buy_price, sell_price, max_quantity, unlimited, enabled)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                item_name = VALUES(item_name), label = VALUES(label), buy_price = VALUES(buy_price), sell_price = VALUES(sell_price),
                max_quantity = VALUES(max_quantity), unlimited = VALUES(unlimited), enabled = VALUES(enabled)`,
            [
                offer.businessId, offer.shopId, offer.id, offer.item, offer.label || null,
                offer.buyPrice ?? null, offer.sellPrice ?? null, offer.maxQuantity, offer.unlimited ? 1 : 0, offer.enabled ? 1 : 0,
            ],
        );
    }

    async function audit(draft: AuditDraft): Promise<HmpBusinessAuditEntry> {
        const id = await database.insert(
            `INSERT INTO hmp_business_audit (business_id, shop_id, offer_id, action, actor_character_id, before_json, after_json, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                draft.businessId, draft.shopId ?? null, draft.offerId ?? null, draft.action.slice(0, 32), draft.actorCharacterId ?? null,
                draft.before ? JSON.stringify(draft.before) : null, draft.after ? JSON.stringify(draft.after) : null, (draft.reason || "").slice(0, 191),
            ],
        );
        const row = await database.single<AuditRow>("SELECT * FROM hmp_business_audit WHERE id = ?", [id]);
        if (!row) throw new Error("business audit row was not written");
        return mapAudit(row);
    }

    async function history(businessId: string, limit: number): Promise<HmpBusinessAuditEntry[]> {
        const rows = await database.query<AuditRow[]>(
            `SELECT * FROM hmp_business_audit WHERE business_id = ? ORDER BY id DESC LIMIT ${Math.max(1, Math.min(200, Math.trunc(limit)))}`,
            [businessId],
        );
        return rows.map(mapAudit);
    }

    return Object.freeze({
        migrate: (migrations: HmpMySQLMigration[]) => database.migrate("hmp-business", migrations),
        loadAll,
        createBusiness,
        updateBusiness,
        deleteBusiness,
        saveShop,
        deleteShop,
        saveOffer,
        audit,
        history,
    });
}

export = { createRepository, mapBusiness, mapShop, mapOffer, mapAudit };
