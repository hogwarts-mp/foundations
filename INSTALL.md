# Install HMP Foundations

This guide is for a server owner installing the complete Foundations pack. Foundations is one versioned
unit: install all twenty-five `hmp-*` resources from the same release and upgrade them together.

## Before you begin

In this guide, `<server-root>` means the working directory used to launch the dedicated server. It is
normally the directory containing `HogwartsMPServer.exe` on Windows or `HogwartsMPServer` on Linux,
and must contain the `resources` and `data` directories described below.

You need:

- a compatible HogwartsMP dedicated server from the [compatibility matrix](COMPATIBILITY.md);
- MySQL 8.x or MariaDB 10.6 or newer;
- permission to create an empty database and a database-scoped user;
- Windows clients using the supported Hogwarts Legacy build. The game client remains Windows-only;
  the dedicated server may run on Windows x64 or Linux x86-64.

Node.js, npm, TypeScript, and this source repository are not required when installing a release ZIP.
Release resources already contain their bundled JavaScript dependencies.

## 1. Create the database

Follow [DATABASE.md](DATABASE.md). In short:

1. Create an empty `hogwartsmp` database using `utf8mb4`.
2. Create a non-root `hogwartsmp` database user with a unique password.
3. Grant that user privileges only on `hogwartsmp.*`.
4. Test the connection from the game-server machine.

Do not import a schema. Foundations creates and upgrades all of its own tables on startup.

## 2. Install the resource pack

Download the release ZIP and open its `hmp-foundations` directory. Copy every directory inside its
`resources` directory into `<server-root>/resources`.

The result must look like this:

```text
<server-root>/
├── HogwartsMPServer.exe      # Windows
│   or HogwartsMPServer       # Linux
├── data/
└── resources/
    ├── hmp-mysql/
    │   ├── package.json
    │   └── dist/
    ├── hmp-core/
    │   ├── package.json
    │   └── dist/
    ├── ...
    └── hmp-webhooks/
        ├── package.json
        └── dist/
```

Do not leave an extra nesting level such as
`<server-root>/resources/hmp-foundations/resources/hmp-core`. There should be exactly twenty-five
top-level `hmp-*` directories.

On Linux, resource and configuration names are case-sensitive. Preserve names such as `hmp-core`
and `data/hmp-mysql.json` exactly.

For example, after extracting the release on Linux:

```sh
sudo mkdir -p /opt/hogwartsmp/resources /opt/hogwartsmp/data
sudo cp -a hmp-foundations/resources/hmp-* /opt/hogwartsmp/resources/
sudo chmod +x /opt/hogwartsmp/HogwartsMPServer
```

Replace `/opt/hogwartsmp` with the actual server root. Run the server as a dedicated, unprivileged
service account and make that account the owner of the server's writable `data` and `logs`
directories. Do not solve permission errors with `chmod -R 777`.

If this server previously used the demonstration resources from the main mod repository, remove or
disable the overlapping resources listed under [Existing-resource overlap](#existing-resource-overlap).
Loading both stacks causes duplicate commands, selectors, input handlers, UI, and conflicting state.

## 3. Install the configuration

Copy the contents of the release's `examples/config/data` directory into `<server-root>/data`.

On Linux, from the directory containing the extracted `hmp-foundations` folder:

```sh
sudo cp -a hmp-foundations/examples/config/data/. /opt/hogwartsmp/data/
```

At minimum:

1. Configure `data/hmp-mysql.json`, or inject the equivalent `HMP_MYSQL_*` environment variables.
   Replace every `CHANGE_ME` value. See [DATABASE.md](DATABASE.md#configure-foundations).
2. Review `data/hmp-spawn.json` and verify its area and coordinates for the supported game build.
3. Review `data/hmp-characters.json`, especially whether character deletion should be enabled.
4. Review `data/hmp-admin.json` and decide which admin-group grades receive each capability.
5. Keep `data/hmp-pvp.json` deny-by-default and lethal mode disabled unless the server deliberately
   wants open-world lethal PvP.
6. Leave `data/hmp-webhooks.json` disabled or inject its Discord URL through the server environment.

The examples are safe starting points, not a complete gameplay configuration. Server-specific shops,
jobs, banks, interactions, activities, and other gameplay registrations belong in separate resources
that consume Foundations APIs.

### Environment variables and secrets

Environment variables must be present in the process that launches the server. Foundations does not
automatically read `environment.example` or `.env` files.

For closed testing before verified MafiaHub identities are available, set a unique admin bootstrap
secret of at least 16 bytes:

```text
HMP_ADMIN_BOOTSTRAP_SECRET=REPLACE_WITH_A_LONG_RANDOM_SECRET
HMP_ADMIN_REQUIRE_VERIFIED=true
HMP_ADMIN_UNSAFE_ASSERTED_BANS=false
# Optional; also set enabled=true in data/hmp-webhooks.json or HMP_WEBHOOKS_ENABLED=true.
HMP_WEBHOOKS_DISCORD_URL=https://discord.com/api/webhooks/...
```

This secret grants session-only access through the masked `/admin` prompt. Do not put it in chat,
commit it, or use it as a permanent staff identity system.

## 4. Start the server

Launch the server with `<server-root>` as its working directory. Relative paths such as
`data/hmp-mysql.json` are resolved from that directory, not from the executable's original location
or the Foundations repository.

### Windows launch

```powershell
Set-Location C:\HogwartsMPServer
$env:HMP_ADMIN_BOOTSTRAP_SECRET = "REPLACE_WITH_A_LONG_RANDOM_SECRET"
.\HogwartsMPServer.exe
```

If using a shortcut, set its **Start in** field to `<server-root>`. If using a service or process
manager, configure its working directory and environment there.

### Linux launch

For a direct shell launch:

```sh
cd /opt/hogwartsmp
export HMP_ADMIN_BOOTSTRAP_SECRET='REPLACE_WITH_A_LONG_RANDOM_SECRET'
./HogwartsMPServer
```

The `export` lasts only for that shell. For a persistent server, use a service manager and store
secrets outside the release directory. A minimal systemd unit looks like this:

```ini
[Unit]
Description=HogwartsMP dedicated server
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=hogwartsmp
Group=hogwartsmp
WorkingDirectory=/opt/hogwartsmp
EnvironmentFile=/etc/hogwartsmp/foundations.env
ExecStart=/opt/hogwartsmp/HogwartsMPServer
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Save the unit as `/etc/systemd/system/hogwartsmp.service`. Create its environment file as root-owned,
group-readable by the service account, and populate it with plain `KEY=value` lines based on
`examples/config/environment.example`:

```sh
sudo install -d -o root -g hogwartsmp -m 0750 /etc/hogwartsmp
sudo install -o root -g hogwartsmp -m 0640 /dev/null /etc/hogwartsmp/foundations.env
sudoedit /etc/hogwartsmp/foundations.env
sudo systemctl daemon-reload
sudo systemctl enable --now hogwartsmp.service
sudo journalctl -u hogwartsmp.service -f
```

The example assumes a `hogwartsmp` system user and group already exist. Create them with the
distribution's normal account-management tools, then give that account write access to the server's
`data` and `logs` directories. Do not place `sudo` in `ExecStart`, and do not run the game server as
root. If the distribution does not use systemd, apply the same working-directory, environment, user,
and restart policy in its service manager.

On either operating system, ensure MySQL/MariaDB is already accepting connections before starting
HogwartsMP. A process manager must preserve `<server-root>` as the working directory; locating the
executable by absolute path is not sufficient by itself.

The current HogwartsMP loader discovers resources automatically. Manifests and dependencies establish
the supported order:

1. `hmp-mysql`
2. `hmp-lib`
3. `hmp-audio`
4. `hmp-ui`
5. `hmp-core`
6. `hmp-pvp`
7. `hmp-houses`
8. `hmp-characters`
9. `hmp-spawn`
10. `hmp-inventory`
11. `hmp-blips`
12. `hmp-banking`
13. `hmp-interact`
14. `hmp-activities`
15. `hmp-doors`
16. `hmp-world`
17. `hmp-npcs`
18. `hmp-emotes`
19. `hmp-shops`
20. `hmp-progression`
21. `hmp-spells`
22. `hmp-duels`
23. `hmp-jobs`
24. `hmp-admin`
25. `hmp-webhooks`

If a server wrapper has a manual resource allowlist, include all twenty-five names and preserve this
order. `hmp-banking` and `hmp-interact` are independent peers at the same priority; their relative
order is not significant.

On first boot, wait for migrations to finish. Healthy logs include the MySQL connection followed by
ready messages from database-backed resources, for example:

```text
[hmp-mysql] connected to 127.0.0.1:3306/hogwartsmp
[hmp-core] Accounts, characters, groups and metadata are ready
[hmp-progression] Character progression, replay-safe rewards, and managed talents ready
```

Do not admit players if any Foundations resource logs `Startup failed`.

## 5. First-player checks

Use a disposable test account first:

- connect, create a character with `/characters`, select it, and reach the configured spawn;
- reconnect and confirm the same character is available;
- open `/inventory` and confirm native and configured custom items appear;
- confirm `hmp-world` applies the configured weather/time and that Hogsmeade flight matches
  `removeBoundaryVolumes`;
- run `/progression status` after selecting the character;
- open `/admin` as a normal player and confirm access is denied or the bootstrap prompt appears;
- enter the bootstrap secret only through the masked admin prompt and confirm the intended staff tools;
- confirm there is only one character selector, inventory UI, interaction prompt, and emote handler.

Use [CLOSED_TESTING.md](CLOSED_TESTING.md) for the full functional test pass.

## Existing-resource overlap

| Existing resource | Guidance |
|---|---|
| `hmp-discord` | Replace with `hmp-webhooks`; loading both duplicates Discord announcements. |
| `charselect` | Do not load with `hmp-characters`; both own character selection and creation. |
| `interactables` | Do not load with `hmp-interact`; both can own the F interaction flow. |
| `rp-core`, `rp-inventory`, `rp-ui`, other `rp-*` | Treat as a separate RP stack. Do not combine persistence or authority models without an explicit bridge. |
| `roles` | Its roles are separate from `hmp-core` groups and do not grant Foundations admin capabilities. |
| `house`, `housepoints` | Do not load with `hmp-houses`; Foundations owns house membership and House Cup history. |
| `items` | Debug/native inventory commands may coexist, but are not recommended on a public server. |
| `audio`, `blips`, `doors`, `emotes`, `spells` | Do not load beside the matching `hmp-*` resource; both would own the same client system. |
| `progression`, `spellupgrades` | Do not load with `hmp-progression`; Foundations owns durable XP, talent points, and managed talents. |
| `duels`, `pvp` | Do not load with `hmp-duels`/`hmp-pvp`; port gamemode policy into the Foundations APIs. |
| `blips-dev`, `spellupgrades`, other probes | Keep diagnostic probes out of production. |
| `gamemode` | May remain for chat and admin commands when it delegates environment policy to `hmp-world`; remove any older build that calls `World.setBoundaryPolicy` directly. |

## Troubleshooting

| Log or symptom | What it usually means | What to check |
|---|---|---|
| `hmp-mysql is not configured` | No enabled JSON file or environment connection settings were found. | Confirm `<server-root>/data/hmp-mysql.json` exists and that the process working directory is `<server-root>`. |
| `ECONNREFUSED` or connection timeout | Nothing is reachable at the configured host/port. | Start MySQL, check port/firewall, and remember that `127.0.0.1` inside a container means that container. |
| `Access denied for user` | Password or MySQL user-host pairing is wrong. | Test with the MySQL CLI from the game-server machine and inspect `SHOW GRANTS`. |
| `Unknown database` | The database itself was never created or its name differs. | Create the empty database and make `HMP_MYSQL_DATABASE`/JSON match exactly. |
| `Failed to open the referenced table 'hmp_characters'` | A dependent resource started without a completed `hmp-core` schema, often because packs were mixed or ordering was overridden. | Stop the server, install one complete release, restore manifest ordering, and inspect the `hmp-core` startup error first. |
| `Cannot add foreign key constraint` | Existing tables have an incompatible schema/engine, or resources are from different versions. | For a new install, use an empty database. Otherwise inspect migration history and restore the matching backup rather than editing constraints blindly. |
| `migration ... was modified after it was applied` | Code and recorded migration checksums do not match. | Install the exact pack version that owns the database; never edit `hmp_schema_migrations` to silence it. |
| Commands print `No character is active` | The player has not selected a Foundations character. | Run `/characters`, select or create a character, then retry. |
| Duplicate UI, commands, or input behavior | Legacy/mod demonstration resources are loaded with Foundations. | Make `<server-root>/resources` Foundations-only or use an explicit allowlist. |
| Configuration changes have no effect | The wrong data directory is being read or the server was not restarted. | Confirm the process working directory, file name, JSON validity, environment overrides, and restart server/client resources. |
| Linux reports `Permission denied` | The binary is not executable or the service user cannot read/write the required path. | Run `chmod +x HogwartsMPServer`, inspect ownership with `ls -la`, and grant the service account access to `data` and `logs`; never use world-writable permissions. |
| Linux reports a missing shared library | The wrong server archive was installed or a required library is absent. | Install the native Linux x86-64 server package and run `ldd ./HogwartsMPServer` from `<server-root>`; the HogwartsMP distribution should include its matching `libnode.so`. |
| A resource works on Windows but is missing on Linux | A path changed case or used Windows separators. | Compare resource/config names exactly and use `/` in Linux paths. |

If startup still fails, capture the first Foundations error—not only later dependency failures—plus the
sanitized MySQL target, pack version, database version, and relevant rows from `hmp_schema_migrations`.
Never post passwords, connection URLs, bootstrap secrets, player IPs, or identity tokens.

## Upgrade and rollback

1. Stop the server and prevent player connections.
2. Back up the Foundations database and `<server-root>/data/hmp-*.json`.
3. Read [CHANGELOG.md](CHANGELOG.md) and compare the new `examples/config` files with local settings.
4. Replace all twenty-five `hmp-*` directories together; do not merge old and new `dist` directories.
5. Start the server and let every migration and resource reach ready state before admitting players.
6. Restart clients after changing client-bearing resources.

Migrations are forward-only. A code rollback does not undo schema changes; restore the corresponding
database backup when a release requires a database rollback.

## Building from source

Server operators should prefer a release ZIP. Contributors building the pack from source need Node.js
22 or newer and npm:

```sh
npm ci
npm run verify
```

The ready-to-install output is written to `build/hmp-foundations`. Install that generated directory
using the same steps above. A source checkout's `resources` directory contains authoring files and is
not the supported deployment artifact.
