# HMP Foundations compatibility

This matrix describes Foundations `0.4.0`. “Supported” means the combination is an intended release
target. “Closed-test” means it is the current validation baseline but has not yet earned a stable
upstream release identifier.

| Component | Supported baseline | Status | Notes |
|---|---|---|---|
| HMP Foundations | `0.4.0` pack and resources | Supported | All twenty-seven resources must use the same version. |
| HogwartsMP scripting host | Mod commit `b85eecf409c59179ef836d613b3a3766f01ed593` or newer | Closed-test | Requires the matching Framework support for script-role manifests and resource containers. Pin the eventual upstream release tag before a public Foundations release. |
| MafiaHub Framework | `16.2.0` or newer | Supported | Required for the `fw://` local resource scheme. On `16.1.x` and older every resource-served page, font, and icon fails to load. |
| Hogwarts Legacy client data | Steam build ID `20773316` | Supported baseline | The native inventory catalog declares this game-data build. Other builds require revalidation. |
| Dedicated-server JavaScript | Embedded Node.js 22 runtime | Supported | Release resources contain bundled dependencies. |
| Source build | Node.js 22 or newer and npm | Supported | `npm ci` followed by `npm run verify`. |
| Database | MySQL 8.x | Supported | `utf8mb4`, UTC, transactional InnoDB tables recommended. |
| Database | MariaDB 10.6 or newer | Supported | Validate a production replica before changing database families. |
| Dedicated server OS | Windows x64 | Supported | Use the Windows server archive and `HogwartsMPServer.exe`. |
| Dedicated server OS | Linux x86-64 | Supported | Use the native Linux server archive and `HogwartsMPServer`; do not use the Windows binary through Wine. |
| Client OS | Windows x64 | Supported | Matches the current Hogwarts Legacy/HogwartsMP client. |

## Required scripting capabilities

Until HogwartsMP publishes a stable version that covers Foundations, compatibility is capability-based.
The host must provide:

- manifest resource dependencies, priorities, exports, and `Imports.get()`;
- ordered `serverScripts`, `clientScripts`, and `sharedScripts` manifest roles, explicit `files`
  asset selection, and resource-container streaming and mounting;
- the `fw://resources/<resource>/<file>` local resource scheme, and client asset streaming of the
  pages, fonts, and icons that resource web views load from it;
- server and client events, player connect/disconnect, UI messaging, and correlated teleport completion;
- `Player.location()` and `playerLocationChanged` for coordinate-space-safe spawns, interactions, and administrative teleports;
- player appearance capture/apply completion for character switching;
- client `Portrait` capture/result/image access and the packaged off-screen avatar proxy used by the
  default character-card renderer;
- server-owned hold/release primitives used by administration;
- `InventoryCatalog` schema version 1 and the server-authoritative player inventory surface, including
  replace, grant/remove, use, persistence control, and revision acknowledgement;
- the current native Galleons definition (with `native:knuts` retained only as a Foundations alias);
- the server-authoritative `player.house` property, including deferred world-ready application and the
  native robe/crest character rebuild;
- client `Doors` logical-lock, Alohomora, physical-door diagnostic, and streaming-aware policy builtins;
- client `Breakables` repairable-object watch, listing, and streaming-aware state apply builtins with the native `breakableState` event (mod commit `59b3cfa9` or newer);
- synchronized `LocalPlayer.playClip`, ability playback/cancellation, emote preview/placement, and
  prop/sound animation-notify replay;
- client key binding, controls, position, browser UI, and resource HTTP assets.
- server/client Wwise playback with automatic required-bank loading, authored stop-event discovery,
  positional range, player-attached/private/global scopes, sound handles, and bank load/unload.
- client `Blips` marker/circle creation, removal, replay clearing, circle pulse, remote-player tracking,
  per-player colors, house tint, scale, and base-icon controls.
- client `Spells` streaming-aware lock policy, exact bonus-loadout management, four-diamond loadout
  read/write, production slot casting, and native `spellCast` events.
- client `Progression` absolute point reconciliation and level-bound lookup, plus native `Talents`
  availability, point, purchase, grant, level, removal, refund, and reset operations.
- server `Pvp` hit policy, live-health `minHp` floors and vitals view; client mutual targetability,
  team relationships, duel context, opponent meter, damage immunity and near-death kneel controls.
- server `NPC.create`, NPC mutation/destruction, `NPCManager`, and `npcDied` events using the verified
  enemy identifiers documented by `hmp-npcs`.

The current PvP host has two presentation caveats: relayed Killing Curse hits do not reproduce the
victim-side green-bolt cosmetic, and target/team writes require the remote proxy to be streamed. Foundations
re-fans complete snapshots for late joiners and exposes `/pvp sync` for recovery; neither caveat weakens
server arbitration or the duel health floor.

Asynchronous resource lifecycle is not a requirement for Foundations `0.4.0`. The current pack still
uses the existing synchronous lifecycle and will adopt the asynchronous contract after upstream
support lands.

## Identity compatibility

The closed-test baseline uses asserted client identifiers because a server-validatable MafiaHub
identity provider is not available yet. Do not treat those identifiers as proof of identity. The
default admin policy requires verified identity for durable bans and keeps unsafe asserted-identity
bans disabled. A later provider should change the trust source without changing Foundations account or
character ownership APIs.

## Version policy

Foundations follows Semantic Versioning at the pack boundary with these pre-`1.0.0` rules:

- The root package, every first-party resource manifest, internal dependency pins, release tag, ZIP,
  and container tag share one exact version.
- The supported installation and rollback unit is the complete pack. Individually adopting a resource
  is possible for developers, but that combination is outside the official compatibility matrix.
- While the major version is zero, a minor release may break resource APIs, configuration, or database
  schemas. Its changelog must call out the migration.
- Patch releases contain fixes and compatible additions whenever practical. Database changes in a
  patch must be forward-compatible within that minor line.
- Release tags use `v<version>`; for example, pack `0.1.0` is tag `v0.1.0`.
- `1.0.0` will begin the normal SemVer contract: breaking changes require a major release, compatible
  features a minor release, and fixes a patch release.

`npm run release:check` enforces lockstep resource versions, internal pins, dependency ordering,
configuration examples, package-lock metadata, and the matching changelog entry. The current
HogwartsMP loader parses dependency version fields but does not yet enforce them at runtime, so this
release check and installing the pack atomically are the safeguards against mixed versions.
