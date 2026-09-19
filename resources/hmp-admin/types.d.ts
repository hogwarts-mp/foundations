import type { HmpCoreAccount, HmpCoreCharacter, HmpCoreGroup, HmpCorePrincipal } from "../hmp-core/types";

export type HmpAdminCapability =
    | "admin.view"
    | "admin.kick"
    | "admin.teleport"
    | "admin.freeze"
    | "admin.noclip"
    | "admin.warn"
    | "admin.ban"
    | "admin.groups"
    | "admin.jobs"
    | "admin.inventory"
    | "admin.spells"
    | "admin.banking"
    | "admin.reconcile"
    | "admin.audit"
    | string;

export interface HmpAdminPlayer {
    id: number;
    nickname: string;
    connected?: boolean;
    ping?: number;
    ip?: string;
    position: { x: number; y: number; z: number };
    virtualWorld?: number;
    emit(eventName: string, payload?: unknown): void;
    kick?(reason?: string): void;
    teleport(x: number, y: number, z: number, options?: { yaw?: number; snapToGround?: boolean; groundSnapDistance?: number }): number;
    hold?(options: { owner: string; x?: number; y?: number; z?: number; radius?: number; radiusZ?: number; mode?: "clamp" | "reject"; rigid?: boolean; ttlMs?: number }): boolean;
    release?(owner: string): boolean;
    holds?(): Array<{ owner: string }>;
    location?(): HogwartsMpPlayerLocation | null;
}

export interface HmpAdminRoleRule {
    group: string;
    minimumGrade?: number;
    capabilities: ReadonlyArray<HmpAdminCapability | "*">;
}

export interface HmpAdminPlayerSummary {
    playerId: number;
    nickname: string;
    ping: number;
    account: HmpCoreAccount;
    character: HmpCoreCharacter | null;
    principal: HmpCorePrincipal;
    groups: HmpCoreGroup[];
    position: { x: number; y: number; z: number };
    location: HogwartsMpPlayerLocation | null;
    virtualWorld: number;
    frozen: boolean;
}

export interface HmpAdminAuditEntry {
    id: number;
    actorAccountId: number | null;
    actorCharacterId: number | null;
    actorPlayerId: number | null;
    action: string;
    targetAccountId: number | null;
    targetCharacterId: number | null;
    targetPlayerId: number | null;
    reason: string;
    metadata: Record<string, unknown>;
    status: "pending" | "completed" | "failed";
    error: string;
    createdAt: string | Date;
    completedAt: string | Date | null;
}

export interface HmpAdminWarning {
    id: number;
    accountId: number;
    actorAccountId: number | null;
    reason: string;
    createdAt: string | Date;
}

export interface HmpAdminBan {
    id: number;
    accountId: number;
    provider: string;
    subject: string;
    trust: string;
    actorAccountId: number | null;
    reason: string;
    expiresAt: string | Date | null;
    createdAt: string | Date;
    revokedAt: string | Date | null;
}

export interface HmpAdminPermissionsApi<P = HmpAdminPlayer> {
    has(player: P, capability: HmpAdminCapability): Promise<boolean>;
    require(player: P, capability: HmpAdminCapability): Promise<true>;
    capabilities(player: P): Promise<HmpAdminCapability[]>;
    /** Session-only test access. Returns false when no bootstrap secret is configured. */
    authenticate(player: P, secret: string): Promise<boolean>;
    revoke(player: P): boolean;
}

export interface HmpAdminPlayersApi<P = HmpAdminPlayer> {
    list(actor: P): Promise<HmpAdminPlayerSummary[]>;
    get(actor: P, target: P | number): Promise<HmpAdminPlayerSummary>;
}

export interface HmpAdminActionsApi<P = HmpAdminPlayer> {
    kick(actor: P, target: P | number, reason: string): Promise<boolean>;
    goto(actor: P, target: P | number, reason?: string): Promise<number>;
    bring(actor: P, target: P | number, reason?: string): Promise<number>;
    freeze(actor: P, target: P | number, reason?: string): Promise<boolean>;
    release(actor: P, target: P | number, reason?: string): Promise<boolean>;
    /** Toggles camera-relative free-flight for the acting administrator. */
    noclip(actor: P, reason?: string): Promise<boolean>;
    inventory(actor: P, target: P | number, operation: "give" | "remove", item: string, amount: number, reason: string): Promise<number>;
    spellGrants(actor: P, target: P | number): Promise<string[]>;
    spell(actor: P, target: P | number, operation: "grant" | "revoke", spell: string, reason: string): Promise<boolean>;
    group(actor: P, target: P | number, operation: "set" | "remove", scope: "account" | "character", group: string, grade: number, reason: string): Promise<boolean>;
    job(actor: P, target: P | number, operation: "hire" | "fire" | "grade", job: string, grade: number, reason: string): Promise<boolean>;
    banking(actor: P, target: P | number, operation: "credit" | "debit", amount: number, currency: string, reason: string): Promise<boolean>;
    reconcile(actor: P, reference: string, resolution: "complete" | "compensate" | "fail", reason: string): Promise<boolean>;
}

export interface HmpAdminModerationApi<P = HmpAdminPlayer> {
    warn(actor: P, target: P | number, reason: string): Promise<HmpAdminWarning>;
    warnings(actor: P, target: P | number): Promise<HmpAdminWarning[]>;
    ban(actor: P, target: P | number, reason: string, hours?: number): Promise<HmpAdminBan>;
    unban(actor: P, banId: number, reason: string): Promise<boolean>;
    bans(actor: P, limit?: number): Promise<HmpAdminBan[]>;
}

export interface HmpAdminAuditApi<P = HmpAdminPlayer> {
    history(actor: P, limit?: number, targetAccountId?: number): Promise<HmpAdminAuditEntry[]>;
}

export interface HmpAdminUiApi<P = HmpAdminPlayer> { open(player: P): Promise<boolean>; close(player: P): boolean }

export interface HmpAdminStatus {
    state: "starting" | "ready" | "degraded" | "stopped";
    lastError: string;
    bootstrapEnabled: boolean;
    bootstrapSessions: number;
    pendingTeleports: number;
    activeNoclip: number;
    uptimeMs: number;
}

export interface HmpAdmin<P = HmpAdminPlayer> {
    permissions: HmpAdminPermissionsApi<P>;
    players: HmpAdminPlayersApi<P>;
    actions: HmpAdminActionsApi<P>;
    moderation: HmpAdminModerationApi<P>;
    audit: HmpAdminAuditApi<P>;
    ui: HmpAdminUiApi<P>;
    status(): HmpAdminStatus;
}
