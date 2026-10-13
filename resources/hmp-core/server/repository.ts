import type { HmpCoreAccount, HmpCoreCharacter, HmpCoreGroup, HmpCorePrincipal } from "../types";
import type { HmpMySQLTransaction } from "../../hmp-mysql/types";
import type { Database, IdentityResult, Repository, Scope } from "./internal";

interface AccountRow {
    id: number | string;
    display_name: string;
    created_at: string | Date;
    last_seen_at: string | Date;
    provider?: string;
    subject?: string;
    trust_level?: string;
}
interface CharacterRow {
    id: number | string;
    account_id: number | string;
    slot: number | string;
    name: string;
    status: string;
    created_at: string | Date;
    updated_at: string | Date;
    deleted_at: string | Date | null;
}
interface GroupRow { group_key: string; grade: number | string; metadata_json: unknown }

function parseJson<T>(value: unknown, fallback: T): T {
    if (value === null || value === undefined || value === "") return fallback;
    try { return JSON.parse(String(value)) as T; }
    catch (_) { return fallback; }
}

function accountRow(row: AccountRow): HmpCoreAccount;
function accountRow(row: null): null;
function accountRow(row: AccountRow | null): HmpCoreAccount | null;
function accountRow(row: AccountRow | null): HmpCoreAccount | null {
    return row ? {
        id: Number(row.id),
        displayName: row.display_name,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
    } : null;
}

function characterRow(row: CharacterRow): HmpCoreCharacter;
function characterRow(row: null): null;
function characterRow(row: CharacterRow | null): HmpCoreCharacter | null;
function characterRow(row: CharacterRow | null): HmpCoreCharacter | null {
    return row ? {
        id: Number(row.id),
        accountId: Number(row.account_id),
        slot: Number(row.slot),
        name: row.name,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at,
    } : null;
}

function groupRow(row: GroupRow, scope: Scope): HmpCoreGroup {
    return {
        scope,
        key: row.group_key,
        grade: Number(row.grade),
        metadata: parseJson(row.metadata_json, {}),
    };
}

function createRepository(database: Database): Repository {
    if (!database || typeof database.query !== "function") throw new TypeError("database API is required");

    async function findIdentity(provider: string, subject: string): Promise<IdentityResult | null> {
        const row = await database.single<AccountRow>(
            `SELECT a.id, a.display_name, a.created_at, a.last_seen_at,
                    i.provider, i.subject, i.trust_level
               FROM hmp_account_identities i
               JOIN hmp_accounts a ON a.id = i.account_id
              WHERE i.provider = ? AND i.subject = ?`,
            [provider, subject],
        );
        if (!row) return null;
        return {
            account: accountRow(row),
            principal: { provider: row.provider ?? provider, subject: row.subject ?? subject, trust: row.trust_level ?? "asserted" },
        };
    }

    async function findOrCreateAccount(principal: HmpCorePrincipal, displayName: string): Promise<HmpCoreAccount> {
        const existing = await findIdentity(principal.provider, principal.subject);
        if (existing) {
            await database.update(
                "UPDATE hmp_accounts SET display_name = ?, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?",
                [displayName, existing.account.id],
            );
            await database.update(
                "UPDATE hmp_account_identities SET last_seen_at = CURRENT_TIMESTAMP, trust_level = ? WHERE provider = ? AND subject = ?",
                [principal.trust, principal.provider, principal.subject],
            );
            return { ...existing.account, displayName };
        }

        try {
            return await database.transaction(async (tx: HmpMySQLTransaction) => {
                const accountId = await tx.insert("INSERT INTO hmp_accounts (display_name) VALUES (?)", [displayName]);
                await tx.insert(
                    "INSERT INTO hmp_account_identities (provider, subject, account_id, trust_level) VALUES (?, ?, ?, ?)",
                    [principal.provider, principal.subject, accountId, principal.trust],
                );
                return accountRow(await tx.single<AccountRow>(
                    "SELECT id, display_name, created_at, last_seen_at FROM hmp_accounts WHERE id = ?",
                    [accountId],
                ) as AccountRow);
            });
        } catch (error) {
            const raced = await findIdentity(principal.provider, principal.subject);
            if (raced) return raced.account;
            throw error;
        }
    }

    async function linkIdentity(accountId: number, principal: HmpCorePrincipal): Promise<boolean> {
        const existing = await findIdentity(principal.provider, principal.subject);
        if (existing && existing.account.id !== Number(accountId)) {
            const error = new Error(`Identity ${principal.provider}:${principal.subject} already belongs to another account`);
            Object.assign(error, { code: "HMP_CORE_IDENTITY_CONFLICT" });
            throw error;
        }
        if (existing) {
            await database.update(
                "UPDATE hmp_account_identities SET trust_level = ?, last_seen_at = CURRENT_TIMESTAMP WHERE provider = ? AND subject = ?",
                [principal.trust, principal.provider, principal.subject],
            );
        } else {
            await database.insert(
                "INSERT INTO hmp_account_identities (provider, subject, account_id, trust_level) VALUES (?, ?, ?, ?)",
                [principal.provider, principal.subject, accountId, principal.trust],
            );
        }
        return true;
    }

    async function listIdentities(accountId: number): Promise<HmpCorePrincipal[]> {
        const rows = await database.query<AccountRow[]>(
            "SELECT provider, subject, trust_level FROM hmp_account_identities WHERE account_id = ?",
            [accountId],
        );
        return rows.map((row) => ({ provider: String(row.provider), subject: String(row.subject), trust: row.trust_level ?? "asserted" }));
    }

    const findAccountById = async (id: number): Promise<HmpCoreAccount | null> => accountRow(await database.single<AccountRow>(
        "SELECT id, display_name, created_at, last_seen_at FROM hmp_accounts WHERE id = ?",
        [id],
    ));

    const touchAccount = (id: number, displayName: string): Promise<number> => database.update(
        "UPDATE hmp_accounts SET display_name = ?, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?",
        [displayName, id],
    );

    async function listCharacters(accountId: number): Promise<HmpCoreCharacter[]> {
        const rows = await database.query<CharacterRow[]>(
            "SELECT * FROM hmp_characters WHERE account_id = ? AND status = 'active' ORDER BY slot",
            [accountId],
        );
        return rows.map((row) => characterRow(row));
    }

    const findCharacterById = async (id: number): Promise<HmpCoreCharacter | null> => characterRow(await database.single<CharacterRow>(
        "SELECT * FROM hmp_characters WHERE id = ?",
        [id],
    ));

    async function createCharacter(accountId: number, data: { name: string; slot: number }): Promise<HmpCoreCharacter> {
        const id = await database.insert(
            "INSERT INTO hmp_characters (account_id, slot, name) VALUES (?, ?, ?)",
            [accountId, data.slot, data.name],
        );
        return (await findCharacterById(Number(id))) as HmpCoreCharacter;
    }

    async function deleteCharacter(id: number): Promise<boolean> {
        return (await database.update(
            "UPDATE hmp_characters SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'",
            [id],
        )) > 0;
    }

    async function listAccountGroups(accountId: number): Promise<HmpCoreGroup[]> {
        const rows = await database.query<GroupRow[]>("SELECT group_key, grade, metadata_json FROM hmp_account_groups WHERE account_id = ?", [accountId]);
        return rows.map((row) => groupRow(row, "account"));
    }

    async function listCharacterGroups(characterId: number): Promise<HmpCoreGroup[]> {
        const rows = await database.query<GroupRow[]>("SELECT group_key, grade, metadata_json FROM hmp_character_groups WHERE character_id = ?", [characterId]);
        return rows.map((row) => groupRow(row, "character"));
    }

    async function setGroup(scope: Scope, ownerId: number, key: string, grade: number, metadata: Record<string, unknown>): Promise<HmpCoreGroup> {
        const table = scope === "account" ? "hmp_account_groups" : "hmp_character_groups";
        const column = scope === "account" ? "account_id" : "character_id";
        await database.update(
            `INSERT INTO ${table} (${column}, group_key, grade, metadata_json) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE grade = VALUES(grade), metadata_json = VALUES(metadata_json)`,
            [ownerId, key, grade, JSON.stringify(metadata || {})],
        );
        return { scope, key, grade, metadata: metadata || {} };
    }

    async function removeGroup(scope: Scope, ownerId: number, key: string): Promise<boolean> {
        const table = scope === "account" ? "hmp_account_groups" : "hmp_character_groups";
        const column = scope === "account" ? "account_id" : "character_id";
        return (await database.update(`DELETE FROM ${table} WHERE ${column} = ? AND group_key = ?`, [ownerId, key])) > 0;
    }

    async function getMetadata(scope: Scope, ownerId: number, key: string): Promise<unknown | undefined> {
        const table = scope === "account" ? "hmp_account_metadata" : "hmp_character_metadata";
        const column = scope === "account" ? "account_id" : "character_id";
        const value = await database.scalar(`SELECT value_json FROM ${table} WHERE ${column} = ? AND meta_key = ?`, [ownerId, key]);
        return value === null ? undefined : parseJson(value, null);
    }

    async function setMetadata<T>(scope: Scope, ownerId: number, key: string, value: T): Promise<T> {
        const table = scope === "account" ? "hmp_account_metadata" : "hmp_character_metadata";
        const column = scope === "account" ? "account_id" : "character_id";
        await database.update(
            `INSERT INTO ${table} (${column}, meta_key, value_json) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE value_json = VALUES(value_json)`,
            [ownerId, key, JSON.stringify(value)],
        );
        return value;
    }

    async function deleteMetadata(scope: Scope, ownerId: number, key: string): Promise<boolean> {
        const table = scope === "account" ? "hmp_account_metadata" : "hmp_character_metadata";
        const column = scope === "account" ? "account_id" : "character_id";
        return (await database.update(`DELETE FROM ${table} WHERE ${column} = ? AND meta_key = ?`, [ownerId, key])) > 0;
    }

    return Object.freeze({
        findIdentity,
        findOrCreateAccount,
        linkIdentity,
        listIdentities,
        findAccountById,
        touchAccount,
        listCharacters,
        findCharacterById,
        createCharacter,
        deleteCharacter,
        listAccountGroups,
        listCharacterGroups,
        setGroup,
        removeGroup,
        getMetadata,
        setMetadata,
        deleteMetadata,
    });
}

export = { createRepository };
// TypeScript source.
