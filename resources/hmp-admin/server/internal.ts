import type { HmpBanking } from "../../hmp-banking/types";
import type { HmpCharacters } from "../../hmp-characters/types";
import type { HmpCore, HmpCoreSession } from "../../hmp-core/types";
import type { HmpInventory } from "../../hmp-inventory/types";
import type { HmpJobs } from "../../hmp-jobs/types";
import type { HmpLogger } from "../../hmp-lib/types";
import type { HmpMySQL, HmpMySQLMigration } from "../../hmp-mysql/types";
import type { HmpSpellsServer } from "../../hmp-spells/types";
import type { HmpUiServer } from "../../hmp-ui/types";
import type { HmpWorld } from "../../hmp-world/types";
import type { HmpAdminAuditEntry, HmpAdminBan, HmpAdminCapability, HmpAdminRoleRule, HmpAdminWarning } from "../types";

export type Player = HogwartsMpPlayer;
export type Core = HmpCore<Player>;
export type Inventory = HmpInventory<Player>;
export type Banking = HmpBanking<Player>;
export type Characters = HmpCharacters<Player>;
export type Jobs = HmpJobs<Player>;
export type Spells = HmpSpellsServer<Player>;
export type Ui = HmpUiServer<Player>;
export type World = HmpWorld<Player>;
export type Database = HmpMySQL;
export type Logger = Pick<HmpLogger, "debug" | "info" | "warn" | "error">;

export interface AdminNoclipConfig {
    speed: number;
    boost: number;
    tickMs: number;
    movement: {
        forward: string;
        back: string;
        left: string;
        right: string;
        up: string;
        down: string;
        boost: string;
    };
}

export interface AdminConfig extends Record<string, unknown> {
    command: string;
    requireVerifiedIdentity: boolean;
    allowUnsafeAssertedBans: boolean;
    teleportTimeoutMs: number;
    auditPageSize: number;
    roleRules: HmpAdminRoleRule[];
    bootstrapSecret: string;
    noclip: AdminNoclipConfig;
}

export interface AuditStart {
    actor: HmpCoreSession<Player> | null;
    action: string;
    target: HmpCoreSession<Player> | null;
    reason: string;
    metadata?: Record<string, unknown>;
}

export interface BanInput {
    accountId: number;
    provider: string;
    subject: string;
    trust: string;
    actorAccountId: number | null;
    reason: string;
    expiresAt: Date | null;
}

export interface AdminRepository {
    start(migrations: HmpMySQLMigration[]): Promise<void>;
    beginAudit(input: AuditStart): Promise<number>;
    finishAudit(id: number, status: "completed" | "failed", error?: string, metadata?: Record<string, unknown>): Promise<void>;
    audit(limit: number, targetAccountId?: number): Promise<HmpAdminAuditEntry[]>;
    addWarning(accountId: number, actorAccountId: number | null, reason: string): Promise<HmpAdminWarning>;
    warnings(accountId: number, limit: number): Promise<HmpAdminWarning[]>;
    addBan(input: BanInput): Promise<HmpAdminBan>;
    activeBan(session: HmpCoreSession<Player>): Promise<HmpAdminBan | null>;
    revokeBan(id: number, actorAccountId: number | null, reason: string): Promise<boolean>;
    bans(limit: number): Promise<HmpAdminBan[]>;
}

export interface AdminPermissions {
    has(player: Player, capability: HmpAdminCapability): Promise<boolean>;
    require(player: Player, capability: HmpAdminCapability): Promise<true>;
    capabilities(player: Player): Promise<HmpAdminCapability[]>;
    authenticate(player: Player, secret: string): Promise<boolean>;
    revoke(player: Player): boolean;
    isBootstrapped(player: Player): boolean;
    status(): { bootstrapEnabled: boolean; bootstrapSessions: number };
}
