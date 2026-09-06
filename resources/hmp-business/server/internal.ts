import type { HmpBanking } from "../../hmp-banking/types";
import type { HmpCore } from "../../hmp-core/types";
import type { HmpInteractServer } from "../../hmp-interact/types";
import type { HmpInventory } from "../../hmp-inventory/types";
import type { HmpJobs } from "../../hmp-jobs/types";
import type { HmpLibServer, HmpLogger } from "../../hmp-lib/types";
import type { HmpMySQL, HmpMySQLMigration } from "../../hmp-mysql/types";
import type { HmpShops } from "../../hmp-shops/types";
import type { HmpUiServer } from "../../hmp-ui/types";

import type {
    HmpBusiness,
    HmpBusinessAuditEntry,
    HmpBusinessDefinition,
    HmpBusinessOffer,
    HmpBusinessOfferInput,
    HmpBusinessPlayer,
    HmpBusinessShop,
    HmpBusinessShopInput,
    HmpBusinesses,
} from "../types";

export type Player = HogwartsMpPlayer & HmpBusinessPlayer;
export type BusinessValues = Omit<HmpBusiness, "createdAt" | "updatedAt">;
export type Core = HmpCore<Player>;
export type Inventory = HmpInventory<Player>;
export type Interact = HmpInteractServer<Player>;
export type Ui = HmpUiServer<Player>;
export type Banking = HmpBanking<Player>;
export type Shops = HmpShops<Player>;
export type Jobs = HmpJobs<Player>;
export type Lib = Pick<HmpLibServer<Player>, "player" | "position">;
export type Database = HmpMySQL;
export type Logger = Pick<HmpLogger, "info" | "warn" | "error">;

export interface AdminGroup {
    key: string;
    minimumGrade: number;
}

export interface SeedShop extends HmpBusinessShopInput {
    offers: HmpBusinessOfferInput[];
}

export interface SeedBusiness extends HmpBusinessDefinition {
    shops: SeedShop[];
}

export interface PriceConfig {
    floor: number;
    ceiling: number;
    /** Per-currency ceilings that override `ceiling`. */
    ceilings: Record<string, number>;
}

export interface HouseCutConfig {
    /** Whole-number percentage of every purchase moved to the treasury organization; 0 disables it. */
    percent: number;
    organizationId: string;
    label: string;
    /** Currency of the treasury organization registered when none exists yet. */
    currency: string;
}

export interface CommandConfig {
    enabled: boolean;
    command: string;
    adminGroups: AdminGroup[];
}

export interface BusinessConfig {
    prices: PriceConfig;
    houseCut: HouseCutConfig;
    commands: CommandConfig;
    businesses: SeedBusiness[];
}

export interface AuditDraft {
    businessId: string;
    shopId?: string | null;
    offerId?: string | null;
    action: string;
    actorCharacterId?: number | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    reason?: string;
}

export interface BusinessRepository {
    migrate(migrations: HmpMySQLMigration[]): Promise<unknown>;
    loadAll(): Promise<{ businesses: HmpBusiness[]; shops: HmpBusinessShop[]; offers: HmpBusinessOffer[] }>;
    /** Resolves null when the id is already taken. */
    createBusiness(values: BusinessValues): Promise<HmpBusiness | null>;
    updateBusiness(values: BusinessValues): Promise<HmpBusiness>;
    deleteBusiness(id: string): Promise<boolean>;
    saveShop(shop: HmpBusinessShop): Promise<void>;
    deleteShop(businessId: string, shopId: string): Promise<boolean>;
    saveOffer(offer: HmpBusinessOffer): Promise<void>;
    audit(draft: AuditDraft): Promise<HmpBusinessAuditEntry>;
    history(businessId: string, limit: number): Promise<HmpBusinessAuditEntry[]>;
}

export interface BusinessEvents {
    emit(eventName: string, ...args: unknown[]): unknown;
}

export interface BusinessDependencies {
    repository: BusinessRepository;
    core: Core;
    inventory: Inventory;
    interact: Interact;
    ui: Ui;
    banking: Banking;
    shops: Shops;
    jobs: Jobs;
    lib: Lib;
    events: BusinessEvents;
    logger: Logger;
    migrations: HmpMySQLMigration[];
    config: Pick<BusinessConfig, "prices" | "houseCut">;
    now?: () => number;
    /** Local calendar day used for the daily sales tally. */
    today?: () => string;
}

export interface DutyEvent {
    player: Player | null;
    job: { id: string } | null;
    onDuty: boolean;
}

export interface ShopTradeEvent {
    player: Player;
    shop: { id: string; resource: string };
    transaction: { reference: string; totalPrice: number; direction: "buy" | "sell" };
}

export interface BusinessService extends HmpBusinesses<Player> {
    start(): Promise<void>;
    /** Insert data-declared businesses that do not exist yet. Resolves to how many were created. */
    seed(businesses: SeedBusiness[]): Promise<number>;
    /** Management menu for administration tooling: skips the `shop.manage` check. */
    manageTrusted(player: Player, businessId?: string): Promise<unknown>;
    onDuty(event: DutyEvent): void;
    onPurchased(event: ShopTradeEvent): Promise<void>;
    onSold(event: ShopTradeEvent): void;
    onResourceStart(name?: string): void;
    disconnect(player: Player): boolean;
    stop(): Promise<void>;
}
