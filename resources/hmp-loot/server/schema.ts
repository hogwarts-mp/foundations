// character_id 0 holds a shared take; times are epoch milliseconds so a respawn survives a restart exactly.
const migrations = [{
    version: 1,
    name: "create loot takes",
    statements: [
        `CREATE TABLE IF NOT EXISTS hmp_loot_takes (
            lootable_key VARCHAR(64) NOT NULL,
            character_id BIGINT UNSIGNED NOT NULL,
            account_id BIGINT UNSIGNED NULL,
            taken_at BIGINT UNSIGNED NOT NULL,
            respawn_at BIGINT UNSIGNED NULL,
            PRIMARY KEY (lootable_key, character_id),
            KEY idx_hmp_loot_takes_respawn (respawn_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
}];

export = { migrations };
