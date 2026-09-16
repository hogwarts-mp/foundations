# hmp-mysql

Shared, promise-based SQL access for HMP Foundations resources. It uses a connection pool and the
MySQL protocol, so it supports both **MySQL 8** and current **MariaDB** servers. It is not affiliated
with Overextended and does not claim drop-in `oxmysql` compatibility.

Server operators should follow the pack's [database setup guide](../../DATABASE.md) for database/user
creation, Docker deployment, credentials, first-boot migrations, backups, and troubleshooting.

`hmp-mysql` is server-only. SQLite is deliberately outside this resource: its embedded deployment,
locking model and SQL behavior are different enough to deserve a future `hmp-sqlite` resource.
HogwartsMP's built-in `Storage` remains the zero-configuration choice for simple key/value state.

## Distribution

Foundations release artifacts contain a bundled `dist/main.js`, including the database driver. A
server operator does not install npm packages. Contributors working from source run `npm ci` and
`npm run build` at the Foundations repository root.

The resource is inert when it has no configuration, so including Foundations does not force every
server to run a database.

## Configure

Set one connection URL in the server environment:

```text
HMP_MYSQL_URL=mysql://hogwartsmp:password@127.0.0.1:3306/hogwartsmp
```

`mariadb://` is also accepted. Alternatively create `data/hmp-mysql.json` beside the server:

```json
{
  "host": "127.0.0.1",
  "port": 3306,
  "user": "hogwartsmp",
  "password": "replace-me",
  "database": "hogwartsmp",
  "connectionLimit": 10,
  "ssl": false
}
```

Keep this file out of source control. Environment values override the file:

| Variable | Purpose |
|---|---|
| `HMP_MYSQL_ENABLED` | Explicitly enable or disable the resource. |
| `HMP_MYSQL_CONFIG` | Alternate JSON config path, relative to the server working directory. |
| `HMP_MYSQL_HOST`, `HMP_MYSQL_PORT` | Server address. |
| `HMP_MYSQL_USER`, `HMP_MYSQL_PASSWORD`, `HMP_MYSQL_DATABASE` | Credentials and schema. |
| `HMP_MYSQL_CONNECTION_LIMIT` | Maximum pooled connections; default `10`. |
| `HMP_MYSQL_QUEUE_LIMIT` | Maximum queued requests; `0` means unlimited. |
| `HMP_MYSQL_CONNECT_TIMEOUT` | Connection timeout in milliseconds; default `10000`. |
| `HMP_MYSQL_CHARSET`, `HMP_MYSQL_TIMEZONE` | Defaults to `utf8mb4` and `Z`. |
| `HMP_MYSQL_SSL` | `true` enables TLS with certificate verification. |

Passwords and connection URLs are never returned by `status()` or written to the normal startup log.
Multiple SQL statements are always disabled.

## Use from another resource

Declare the dependency so `hmp-mysql` starts first:

```json
"resourceDependencies": [{ "name": "hmp-mysql", "version": "0.4.1" }]
```

Then import its exports:

```js
/** @type {import("../../hmp-mysql/types").HmpMySQL} */
const MySQL = Imports.get("hmp-mysql");

const characters = await MySQL.query(
    "SELECT * FROM characters WHERE account_id = ?",
    [accountId],
);

const character = await MySQL.single(
    "SELECT * FROM characters WHERE id = :id",
    { id: characterId },
);

const name = await MySQL.scalar(
    "SELECT name FROM characters WHERE id = ?",
    [characterId],
);
```

Both positional `?` placeholders and named `:name` placeholders are supported. `query` uses safe
driver escaping and supports conveniences such as array expansion. `prepare` uses MySQL server-side
prepared statements and therefore accepts only values the prepared-statement protocol can bind.

## Writes and transactions

```js
const id = await MySQL.insert(
    "INSERT INTO characters (account_id, name) VALUES (?, ?)",
    [accountId, name],
);

const changed = await MySQL.update(
    "UPDATE characters SET last_seen = CURRENT_TIMESTAMP WHERE id = ?",
    [id],
);

await MySQL.transaction(async (tx) => {
    await tx.update("UPDATE accounts SET gold = gold - ? WHERE id = ?", [cost, buyerId]);
    await tx.update("UPDATE accounts SET gold = gold + ? WHERE id = ?", [cost, sellerId]);
});
```

An array form is available for data-driven batches:

```js
await MySQL.transaction([
    { query: "UPDATE accounts SET gold = gold - ? WHERE id = ?", values: [cost, buyerId] },
    { query: "UPDATE accounts SET gold = gold + ? WHERE id = ?", values: [cost, sellerId] },
]);
```

## Resource-owned migrations

Each resource owns a monotonically versioned migration list. `migrate` serializes concurrent starts
with a MySQL advisory lock, records checksums in `hmp_schema_migrations`, skips applied versions, and
refuses to continue if an applied migration was edited later.

```js
await MySQL.migrate("my-resource", [
    {
        version: 1,
        name: "create characters",
        up: `CREATE TABLE IF NOT EXISTS characters (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(80) NOT NULL
        ) ENGINE=InnoDB`,
    },
    {
        version: 2,
        name: "index character names",
        statements: [
            "CREATE INDEX idx_characters_name ON characters (name)",
        ],
    },
]);
```

MySQL and MariaDB implicitly commit many DDL statements. Schema migrations must therefore be
rerunnable—prefer `IF NOT EXISTS` and avoid mixing destructive data rewrites with DDL in one version.
The ledger row is written only after every statement succeeds.

Failures reject the Promise. Transactions roll back and rethrow the original error. `ready()` is the
exception: it returns `false` when disabled or unreachable, making it suitable for health checks.
`status()` reports the sanitized target, state and basic query counters.
