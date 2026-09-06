import type { HmpInteractionCharacter, HmpInteractVector3 } from "../hmp-interact/types";

export interface HmpBusinessPlayer {
    id: number;
    nickname?: string;
    connected?: boolean;
    position: HmpInteractVector3;
    virtualWorld?: number;
    emit(eventName: string, payload?: unknown): void;
    location?(): HogwartsMpPlayerLocation | null;
}

/**
 * How a counter behaves around duty.
 * - `always`: open whether or not staff are on duty; the vendor body stands in while nobody is.
 * - `staffed`: open only while an employee is on duty within `staffRadius` of the counter; the vendor
 *   body is shown while nobody is, and customers are told nobody is at the counter.
 * - `kiosk`: always open and never shows a vendor body.
 */
export type HmpBusinessStaffing = "always" | "staffed" | "kiosk";

export interface HmpBusiness {
    id: string;
    jobId: string;
    label: string;
    /** hmp-banking currency of the organization account. The till provider is registered as `business:<id>`. */
    currency: string;
    enabled: boolean;
    createdAt: string | Date;
    updatedAt: string | Date;
}

export interface HmpBusinessShop {
    businessId: string;
    id: string;
    label: string;
    description?: string;
    position: HmpInteractVector3;
    areaId?: string;
    regionId?: string;
    /** Activation radius of the counter prompt in centimetres. */
    radius: number;
    /** How close an on-duty employee must stand to the counter for it to count as staffed, in centimetres. */
    staffRadius: number;
    /** Optional surveyed clock-in zone for this counter. Null relies on the job's own duty points. */
    dutyPoint: HmpInteractVector3 | null;
    vendor: HmpInteractionCharacter | null;
    staffing: HmpBusinessStaffing;
    enabled: boolean;
}

export interface HmpBusinessOffer {
    businessId: string;
    shopId: string;
    id: string;
    item: string;
    label?: string;
    buyPrice?: number;
    /** Administrator-set price on a sell-only offer (no `buyPrice`). Offers customers buy never carry one. */
    sellPrice?: number;
    /**
     * Share of the item's reference value the shop pays when buying back, in `0..1` and capped by
     * `prices.buybacks.maxRatio`. Only effective while buybacks are enabled and the item has a reference value.
     */
    buybackRatio: number | null;
    maxQuantity: number;
    /** Unlimited offers never track stock; everything else is finite and lives in hmp-shops. */
    unlimited: boolean;
    enabled: boolean;
}

export interface HmpBusinessDefinition {
    id: string;
    jobId: string;
    label?: string;
    currency?: string;
    enabled?: boolean;
}

export interface HmpBusinessShopInput {
    id: string;
    label?: string;
    description?: string;
    position: HmpInteractVector3;
    areaId?: string;
    regionId?: string;
    radius?: number;
    staffRadius?: number;
    dutyPoint?: HmpInteractVector3 | null;
    vendor?: HmpInteractionCharacter | null;
    staffing?: HmpBusinessStaffing;
    enabled?: boolean;
}

export interface HmpBusinessOfferInput {
    id: string;
    item: string;
    label?: string;
    buyPrice?: number | null;
    /** Administrator-only, and only on sell-only offers. Managers set `buybackRatio` instead. */
    sellPrice?: number | null;
    buybackRatio?: number | null;
    maxQuantity?: number;
    unlimited?: boolean;
    enabled?: boolean;
    /** Initial stock written when the offer is first created. Ignored for unlimited offers. */
    stock?: number;
}

export interface HmpBusinessMutationOptions<P = HmpBusinessPlayer> {
    /**
     * Acting player or character id. Omitted or null means a trusted resource or administrator. A value
     * must hold the job permission `shop.manage`; creating businesses and placing counters stay
     * administrator-only regardless.
     */
    actor?: P | number | null;
    /**
     * Set by administration tooling acting on behalf of `actor`: the actor is still written to the
     * ledger, but the `shop.manage` check and the administrator-only restrictions are skipped.
     */
    admin?: boolean;
    reason?: string;
}

export interface HmpBusinessAuditEntry {
    id: number;
    businessId: string;
    shopId: string | null;
    offerId: string | null;
    action: string;
    actorCharacterId: number | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    reason: string;
    createdAt: string | Date;
}

export interface HmpBusinessShopSales {
    shopId: string;
    label: string;
    purchases: number;
    revenue: number;
    buybacks: number;
    spent: number;
}

export interface HmpBusinessBooks {
    businessId: string;
    currency: string;
    /** Organization account balance, or null when the job has no banking. */
    balance: number | null;
    /** Local calendar day (YYYY-MM-DD) the tallies belong to. */
    day: string;
    shops: HmpBusinessShopSales[];
}

export interface HmpBusinessesApi<P = HmpBusinessPlayer> {
    create(definition: HmpBusinessDefinition, options?: HmpBusinessMutationOptions<P>): Promise<HmpBusiness>;
    update(id: string, patch: { label?: string; currency?: string; enabled?: boolean }, options?: HmpBusinessMutationOptions<P>): Promise<HmpBusiness>;
    remove(id: string, options?: HmpBusinessMutationOptions<P>): Promise<boolean>;
    get(id: string): HmpBusiness | null;
    list(): HmpBusiness[];
    /** Businesses the target manages through `shop.manage`. */
    managed(target: P | number): Promise<HmpBusiness[]>;
    /** Re-register every enabled counter with hmp-shops. Resolves to the number of live counters. */
    sync(id?: string): Promise<number>;
}

export interface HmpBusinessShopsApi<P = HmpBusinessPlayer> {
    add(businessId: string, shop: HmpBusinessShopInput, options?: HmpBusinessMutationOptions<P>): Promise<HmpBusinessShop>;
    update(businessId: string, shopId: string, patch: Partial<Omit<HmpBusinessShopInput, "id">>, options?: HmpBusinessMutationOptions<P>): Promise<HmpBusinessShop>;
    remove(businessId: string, shopId: string, options?: HmpBusinessMutationOptions<P>): Promise<boolean>;
    get(businessId: string, shopId: string): HmpBusinessShop | null;
    list(businessId?: string): HmpBusinessShop[];
    /** True when an on-duty employee stands within `staffRadius` of the counter. */
    isStaffed(businessId: string, shopId: string): boolean;
    /** The id the counter is registered under in hmp-shops. */
    shopId(businessId: string, shopId: string): string;
}

export interface HmpBusinessOffersApi<P = HmpBusinessPlayer> {
    set(businessId: string, shopId: string, offer: HmpBusinessOfferInput, options?: HmpBusinessMutationOptions<P>): Promise<HmpBusinessOffer>;
    setPrices(businessId: string, shopId: string, offerId: string, prices: { buyPrice?: number | null; sellPrice?: number | null; buybackRatio?: number | null }, options?: HmpBusinessMutationOptions<P>): Promise<HmpBusinessOffer>;
    /** The price the shop currently pays for one unit, or null when it does not buy that offer back. */
    buybackPrice(businessId: string, shopId: string, offerId: string): number | null;
    /** Server-owned reference value of an item: the config override, else the item definition's `referenceValue`. */
    referenceValue(item: string): number | null;
    retire(businessId: string, shopId: string, offerId: string, options?: HmpBusinessMutationOptions<P>): Promise<HmpBusinessOffer>;
    restore(businessId: string, shopId: string, offerId: string, options?: HmpBusinessMutationOptions<P>): Promise<HmpBusinessOffer>;
    get(businessId: string, shopId: string, offerId: string): HmpBusinessOffer | null;
    list(businessId: string, shopId?: string, includeRetired?: boolean): HmpBusinessOffer[];
}

export interface HmpBusinessStockApi<P = HmpBusinessPlayer> {
    get(businessId: string, shopId: string, offerId: string): Promise<number | null>;
    /** Administrator seeding. Shop managers restock from inventory instead. */
    set(businessId: string, shopId: string, offerId: string, quantity: number, options?: HmpBusinessMutationOptions<P>): Promise<number>;
    /** Move items from the player's inventory onto the shelf. */
    restock(player: P, businessId: string, shopId: string, offerId: string, quantity: number, options?: HmpBusinessMutationOptions<P>): Promise<number>;
    /** Move items from the shelf into the player's inventory, capped at current stock. */
    withdraw(player: P, businessId: string, shopId: string, offerId: string, quantity: number, options?: HmpBusinessMutationOptions<P>): Promise<number>;
    /** Move stock between two counters of the same business without an inventory round-trip. */
    transfer(businessId: string, fromShopId: string, toShopId: string, offerId: string, quantity: number, options?: HmpBusinessMutationOptions<P>): Promise<{ from: number; to: number }>;
}

export interface HmpBusinessBooksApi<P = HmpBusinessPlayer> {
    summary(businessId: string, options?: HmpBusinessMutationOptions<P>): Promise<HmpBusinessBooks>;
}

export interface HmpBusinessUiApi<P = HmpBusinessPlayer> {
    /** Management menu gated on `shop.manage`. Without a business id the player picks among theirs. */
    manage(player: P, businessId?: string): Promise<unknown>;
    close(player: P): boolean;
}

export interface HmpBusinessAuditApi {
    history(businessId: string, limit?: number): Promise<HmpBusinessAuditEntry[]>;
}

export interface HmpBusinessStatus {
    state: "starting" | "ready" | "degraded" | "stopped";
    lastError: string;
    businesses: number;
    shops: number;
    liveShops: number;
    offers: number;
    openMenus: number;
    uptimeMs: number;
}

export interface HmpBusinesses<P = HmpBusinessPlayer> {
    businesses: HmpBusinessesApi<P>;
    shops: HmpBusinessShopsApi<P>;
    offers: HmpBusinessOffersApi<P>;
    stock: HmpBusinessStockApi<P>;
    books: HmpBusinessBooksApi<P>;
    ui: HmpBusinessUiApi<P>;
    audit: HmpBusinessAuditApi;
    status(): HmpBusinessStatus;
}
