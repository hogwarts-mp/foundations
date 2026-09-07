# HMP Foundations

HMP Foundations is the cohesive, versioned stack of common resources for HogwartsMP servers. Its
resources share the `hmp-` namespace, are designed and tested together, and remain independently
adoptable through normal resource dependencies.

This repository is separate from the MafiaHub C++ Framework used to build HogwartsMP. Foundations is
the server scripting layer built on top of that runtime.

Installing a server? Start with [INSTALL.md](INSTALL.md). It covers the directory layout,
[database creation and credentials](DATABASE.md), configuration, first boot, and troubleshooting.
Release ZIPs are prebuilt; server owners do not need Node.js, npm, TypeScript, or this source tree.
The dedicated server may run on Windows x64 or Linux x86-64; Hogwarts Legacy clients remain Windows.

## Resources

| Resource | Purpose |
|---|---|
| [`hmp-admin`](resources/hmp-admin) | Capability-gated moderation, corrective actions, recovery tools and persistent audit history. |
| [`hmp-mysql`](resources/hmp-mysql) | Pooled, promise-based MySQL and MariaDB access. |
| [`hmp-lib`](resources/hmp-lib) | Shared utilities, input/control ownership, shortcut arbitration, validation, commands, targeting, localization and logging. |
| [`hmp-pvp`](resources/hmp-pvp) | Composable, fail-closed PvP arbitration plus server-wide consent/lethal modes. |
| [`hmp-audio`](resources/hmp-audio) | Owner-scoped Wwise playback, aliases, audience helpers and reference-counted soundbanks. |
| [`hmp-ui`](resources/hmp-ui) | Shared notifications, dialogs, context menus, input and progress primitives. |
| [`hmp-core`](resources/hmp-core) | Persistent accounts, identity links, characters, groups and metadata. |
| [`hmp-houses`](resources/hmp-houses) | Character houses, native robe/crest synchronization, group projection and an audited House Cup ledger. |
| [`hmp-characters`](resources/hmp-characters) | Multicharacter creation, selection and appearance flow. |
| [`hmp-spawn`](resources/hmp-spawn) | Spawn selection and character-scoped last-location persistence. |
| [`hmp-inventory`](resources/hmp-inventory) | Custom item slots, atomic container transfers and a unified, character-scoped view of native game items. |
| [`hmp-blips`](resources/hmp-blips) | Owner-scoped map, minimap, compass, search-area and group-aware player markers. |
| [`hmp-interact`](resources/hmp-interact) | Server-authoritative world zones, prompts, requirements and interaction handlers. |
| [`hmp-doors`](resources/hmp-doors) | Group-aware physical door and logical lock access with character-scoped grants. |
| [`hmp-world`](resources/hmp-world) | Server-wide weather, time, season, mount-boundary, ambient-population and native-encounter defaults. |
| [`hmp-worldstate`](resources/hmp-worldstate) | Persisted world state players change: repairable objects (Reparo) shared by everyone, plus a keyed store for further systems. |
| [`hmp-npcs`](resources/hmp-npcs) | Verified enemy catalog plus resource-scoped NPC spawning, ownership and cleanup. |
| [`hmp-emotes`](resources/hmp-emotes) | Curated synchronized emotes, account favorites, live alias editing and replaceable picker UI. |
| [`hmp-spells`](resources/hmp-spells) | Character-scoped spell grants, group-aware policy rules, bonus loadouts and advisory cast events. |
| [`hmp-activities`](resources/hmp-activities) | Public group discovery, role/team composition, readiness and reusable activity-session lifecycle. |
| [`hmp-duels`](resources/hmp-duels) | Consensual, non-lethal wizard duels using activity invitations and native PvP presentation. |
| [`hmp-shops`](resources/hmp-shops) | Server-owned catalogs, native Galleons, persistent stock and audited buy/sell flows. |
| [`hmp-progression`](resources/hmp-progression) | Character XP, native-confirmed levels, talent points, managed talents and replay-safe rewards. |
| [`hmp-banking`](resources/hmp-banking) | Character and organization accounts, native-cash exchange, atomic transfers and an audited ledger. |
| [`hmp-jobs`](resources/hmp-jobs) | Persistent employment, grades, duty, permissions, management and bank-backed payroll. |
| [`hmp-business`](resources/hmp-business) | Player-run businesses: job-owned counters with owner-managed prices, stock, staffing and books. |
| [`hmp-webhooks`](resources/hmp-webhooks) | Server-only named webhook destinations, queued delivery, retries and optional gameplay-event relays. |

## Development

Node.js 22 or newer is required for Foundations's build tools. The generated resources target Node.js
22 and run on the newer embedded Node runtime shipped by HogwartsMP.

```sh
npm ci
npm test
npm run verify
```

Resource implementations are strict TypeScript under each resource's `server/`, `client/`, and
`shared/` directories. Builds remain bundled CommonJS JavaScript for server entrypoints (and IIFE
JavaScript for browser clients) under `dist/`; runtime manifests continue to reference those generated
JavaScript files. Source-level unit tests use `tsx`, while smoke tests execute the compiled bundles.

Resource manifests declare ordered `mafiahub.serverScripts` and `mafiahub.clientScripts` lists.
Client resources also declare `mafiahub.files` for the generated bundle and any pages, fonts, icons,
or data they need. For example, `hmp-inventory` uses:

```json
"mafiahub": {
  "serverScripts": ["dist/server.js"],
  "clientScripts": ["dist/client.js"],
  "files": ["dist/client.js", "dist/index.html", "dist/fonts/**", "dist/icons/**"]
}
```

The host streams `clientScripts`, optional `sharedScripts` (which execute on both sides),
`package.json`, and the assets selected by `files` to clients. Keep these paths relative to the
resource root and point them at built files under `dist/`. Client dependencies are bundled into
`dist/client.js`; avoid `dist/**` or `dist/*.js` because server bundles share that directory.
Resources with only `serverScripts` have no client package. Client assets retain their
`fw://resources/<resource>/<file>` URLs with the new resource containers.

`npm run package` writes a ready-to-load pack under `build/hmp-foundations/resources/`. Runtime
artifacts contain bundled dependencies: server owners do not run npm inside the game-server image.

For deployment, use the [installation and start-order guide](INSTALL.md) and [database guide](DATABASE.md).
A copy-ready configuration set ships in [`examples/config`](examples/config), and supported runtime combinations are recorded in
the [compatibility matrix](COMPATIBILITY.md). For structured playtest coverage and issue reports, use
the [closed testing guide](CLOSED_TESTING.md).

The repository also publishes `ghcr.io/<owner>/<repository>:edge` from `main` and versioned tags
from releases. This resource-pack image is build input for the runnable Foundations server variant;
server owners normally use that server image or the downloadable ZIP instead of pulling it directly.

## Versioning

Foundations uses one lockstep version for the pack and every first-party resource it contains. Install,
upgrade, and roll back the twenty-seven resources as one unit. Before `1.0.0`, minor releases may contain
breaking API, configuration, or schema changes; patch releases are intended to remain compatible
within their minor line. See the [full version policy](COMPATIBILITY.md#version-policy) and
[changelog](CHANGELOG.md).

## License

HMP Foundations uses the same [MafiaHub OSS license](LICENSE) as the main HogwartsMP mod repository.
