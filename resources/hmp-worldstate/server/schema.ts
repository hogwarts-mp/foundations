const migrations = [{
    version: 1,
    name: "create keyed world state",
    statements: [
        `CREATE TABLE IF NOT EXISTS hmp_world_state (
            system_name VARCHAR(32) NOT NULL,
            state_key VARCHAR(64) NOT NULL,
            state_value VARCHAR(256) NOT NULL,
            updated_by_account_id BIGINT UNSIGNED NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (system_name, state_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
}];

export = { migrations };
