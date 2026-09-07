import type { Database, StoredRow, WorldStateRepository } from "./internal";

interface Row {
    system_name: string;
    state_key: string;
    state_value: string;
    updated_by_account_id: number | string | null;
    updated_at: string | Date | null;
}

function mapRow(row: Row): StoredRow {
    return {
        system: row.system_name,
        key: row.state_key,
        value: row.state_value,
        updatedByAccountId: row.updated_by_account_id === null ? null : Number(row.updated_by_account_id),
        updatedAt: row.updated_at,
    };
}

function createRepository(database: Database): WorldStateRepository {
    return Object.freeze({
        async start(migrations: Parameters<WorldStateRepository["start"]>[0]) {
            if (typeof database.ready === "function" && !await database.ready()) throw new Error("hmp-mysql is not ready");
            await database.migrate("hmp-worldstate", migrations);
        },
        async loadAll() {
            const rows = await database.query<Row[]>("SELECT * FROM hmp_world_state ORDER BY system_name, state_key");
            return rows.map(mapRow);
        },
        async put(system: string, key: string, value: string, actorAccountId: number | null) {
            await database.update(
                `INSERT INTO hmp_world_state (system_name, state_key, state_value, updated_by_account_id)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE state_value = VALUES(state_value),
                    updated_by_account_id = VALUES(updated_by_account_id), updated_at = CURRENT_TIMESTAMP`,
                [system, key, value, actorAccountId],
            );
        },
        async remove(system: string, key: string) {
            await database.update("DELETE FROM hmp_world_state WHERE system_name = ? AND state_key = ?", [system, key]);
        },
        async clear(system: string) {
            return database.update("DELETE FROM hmp_world_state WHERE system_name = ?", [system]);
        },
    });
}

export = { createRepository, mapRow };
