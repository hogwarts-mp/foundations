import type { HmpLootRecord } from "../types";
import type { Database, LootRepository } from "./internal";

interface Row {
    lootable_key: string;
    character_id: number | string;
    account_id: number | string | null;
    taken_at: number | string;
    respawn_at: number | string | null;
}

function mapRow(row: Row): HmpLootRecord {
    const characterId = Number(row.character_id);
    return {
        key: row.lootable_key,
        characterId: characterId === 0 ? null : characterId,
        accountId: row.account_id === null ? null : Number(row.account_id),
        takenAt: Number(row.taken_at),
        respawnAt: row.respawn_at === null ? null : Number(row.respawn_at),
    };
}

function createRepository(database: Database): LootRepository {
    return Object.freeze({
        async start(migrations: Parameters<LootRepository["start"]>[0]) {
            if (typeof database.ready === "function" && !await database.ready()) throw new Error("hmp-mysql is not ready");
            await database.migrate("hmp-loot", migrations);
        },
        async loadAll() {
            const rows = await database.query<Row[]>("SELECT * FROM hmp_loot_takes ORDER BY lootable_key, character_id");
            return rows.map(mapRow);
        },
        async put(record: HmpLootRecord) {
            await database.update(
                `INSERT INTO hmp_loot_takes (lootable_key, character_id, account_id, taken_at, respawn_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE account_id = VALUES(account_id), taken_at = VALUES(taken_at), respawn_at = VALUES(respawn_at)`,
                [record.key, record.characterId ?? 0, record.accountId, record.takenAt, record.respawnAt],
            );
        },
        async remove(key: string, characterId: number | null) {
            await database.update("DELETE FROM hmp_loot_takes WHERE lootable_key = ? AND character_id = ?", [key, characterId ?? 0]);
        },
    });
}

export = { createRepository, mapRow };
