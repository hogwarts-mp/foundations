// One row per character: the bag as JSON, rewritten whole on every change (a bag is a handful of beasts).
const migrations = [{
    version: 1,
    name: "create beast bags",
    statements: [
        `CREATE TABLE IF NOT EXISTS hmp_beast_bags (
            character_id BIGINT UNSIGNED NOT NULL,
            beasts_json LONGTEXT NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (character_id),
            CONSTRAINT fk_hmp_beast_bags_character FOREIGN KEY (character_id) REFERENCES hmp_characters (id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
}];

export = { migrations };
