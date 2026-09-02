# Changelog

All notable HMP Foundations changes are recorded here. The project uses a lockstep pack version and the
pre-`1.0.0` policy documented in [COMPATIBILITY.md](COMPATIBILITY.md#version-policy).

## [Unreleased]

### Added

- `hmp-npcs` as the Foundation-owned, Framework-verified enemy catalog and resource-scoped NPC spawn,
  ownership, limit, death-tracking, and cleanup service.

### Fixed

- `hmp-core`'s `selectCharacter()` now emits `hmp:character:selected` for every successful
  selection, not only when reached through `hmp-characters`' `select()` wrapper. Previously,
  `autoSelectSingleCharacter` bypassed the event entirely, silently breaking every resource gated
  behind it (`hmp-spawn`'s teleport, last-location persistence, and autosave tracking, with no
  error anywhere).
- `hmp-characters`' `tryInitialOpen` now skips opening when a character is already active, and
  only marks itself "attempted" after a successful open instead of before -- a transient failure
  no longer permanently disables auto-open for the rest of a session.
- `hmp-characters` and `hmp-spawn` no longer gate their auto-open/auto-spawn flow behind a custom
  client-emitted "ready" ping, which was unreliable in practice. Both now use the native
  `loadingFinished` event instead.

## [0.2.0] - 2026-08-30

### Changed

- Resource web views load from the `fw://resources/…` origin instead of `http://resources/…`, following
  the MafiaHub Framework `16.2.0` local resource scheme. This affects the views in `hmp-characters`,
  `hmp-emotes`, `hmp-inventory`, `hmp-spawn`, and `hmp-ui`, along with inventory item icons and
  `hmp-ui` context-menu icons. Paths after the host are unchanged.
- Foundations now requires MafiaHub Framework `16.2.0` or newer. The `fw://` scheme is not registered on
  older hosts, so every resource-served page, font, and icon fails to load there.
- Set the pack and every first-party resource to lockstep version `0.2.0`.

### Upgrade notes

- Update `ui.url` in any deployed `data/hmp-emotes.json` and `data/hmp-inventory.json` from
  `http://resources/…` to `fw://resources/…` **before** starting the upgraded server. A stored URL on
  the old origin is rejected during configuration load, so the resource does not start and its chat
  commands become silently inert — `/emote menu` simply does nothing. The failure is reported once in
  the server log as `ui.url must be a resource URL or HTTPS URL`.
- Update item `icon` URLs in those same files. Unlike `ui.url` these are accepted, but they name a
  scheme that is no longer served, so affected icons fall back or render broken.
- Resources staged into the server through a directory junction or symlink must be staged as real
  copies instead. Framework `16.2.0` streams view assets to clients by walking the resource directory
  and taking a path relative to the server's resource root; through a link that walk resolves to the
  real location and escapes the root, so pages and fonts never reach the client asset cache.

## [0.1.0] - 2026-08-29

### Added

- `hmp-mysql`, `hmp-lib`, `hmp-ui`, and `hmp-core` as the shared data, utility, UI, account, character,
  group, metadata, input-ownership, and shortcut foundations.
- `hmp-characters` and `hmp-spawn` for multicharacter creation, selection, appearance, configured
  spawning, and character-scoped last locations.
- `hmp-inventory` for custom items, icons, containers, atomic custom-item transfers, and a unified view
  of Framework-owned native game inventory.
- `hmp-interact` and `hmp-shops` for authoritative zones, prompts, requirements, catalog/stock control,
  and audited buy/sell flows.
- `hmp-banking` and `hmp-jobs` for accounts, organizations, transfers, native-cash exchange, employment,
  grades, duty, permissions, management, payroll, and ledgers.
- `hmp-admin` for capability-gated moderation, player correction, recovery, and persistent audit data.
- `hmp-world` for configurable server-wide weather, clock, date, season, native mount-boundary,
  ambient-population and enemy-encounter baselines with synchronized runtime overrides.
- `hmp-progression` for character-scoped XP and native-confirmed levels, replay-safe reward references,
  canonical talent points, durable managed talents, native purchase gating, and reconnect reconciliation.
- `hmp-audio` for owner-scoped server and client Wwise playback, fixed-point/player/private/audience/global
  scopes, synchronized aliases, authored stop-event handling, custom-bank leases, and reload cleanup.
- `hmp-blips` for owner-scoped map/minimap/compass markers, bounded search-circle TTLs, late-join replay,
  fail-closed group/location audiences, and priority-colored area-aware player tracking groups.
- `hmp-doors` for ranked, group-aware physical door and logical lock policies, character-scoped grants,
  streaming-safe client enforcement, and guarded closed-test diagnostics. Chests remain out of scope.
- `hmp-emotes` for server-curated synchronized clips and abilities, Arcanum asset discovery, account
  favorites, group-gated live alias editing, persistent MySQL overrides, placement, and replaceable UI.
- `hmp-spells` for ranked group-aware spell rules, character-scoped grants, managed bonus loadouts,
  owner-cleaned runtime policies, native enforcement, loadout helpers, and rate-limited advisory cast events.
- `hmp-houses` for character-scoped membership, native house application, `hmp-core` group projection,
  membership audit history, and an atomic, replay-safe House Cup points ledger.
- `hmp-activities` for ephemeral public and private lobbies, role/team composition, readiness,
  area-aware discovery, leader handoff, expiry, disconnect cleanup, and owner-driven session lifecycle.
- `hmp-pvp` for deterministic first-decisive PvP policy composition, owner cleanup, fail-closed rule
  errors, and deny-by-default arbitration across duels, arenas, zones, and gamemodes.
- `hmp-duels` for activity-backed challenge invitations, authoritative countdown/damage gating,
  native opponent targeting and meter presentation, non-lethal health floors, kneel, and forfeits.
- Example configuration, installation/start-order guidance, compatibility policy, release packaging,
  and a structured closed-test checklist.

### Changed

- Adopted the upstream `Player.location()` and `playerLocationChanged` contract for area-aware saved
  locations, interaction snapshots, admin inspection, and same-area teleport enforcement.
- Standardized player-facing currency on Galleons. `native:galleons` is canonical and
  `native:knuts` remains a compatibility alias for the same native balance.
- Converted first-party implementation sources to strict TypeScript while keeping bundled JavaScript
  runtime entrypoints.
- Set the pack and every first-party resource to lockstep version `0.1.0`.
- Restyled the shared `hmp-ui` renderer around the Arcanum visual system and replaced invisible native
  CEF select popups with keyboard-accessible, fully composited DOM dropdowns. Chained server menus now
  retain their backdrop and focus lease across short request handoffs instead of flashing the world.
  Large select catalogs can opt into client-side search.
- `hmp-admin` inventory corrections now use server-side catalog search followed by a bounded searchable
  picker of registered custom and native items, including friendly labels, native IDs, categories, and
  holders. This avoids truncated client events with the 1,848-item catalog. `hmp-inventory` also accepts
  raw native item IDs case-insensitively for compatibility with the original Framework commands.
- `hmp-ui` now rejects requests above a conservative safe event-payload budget before transmission and
  caps select choices, preventing malformed truncated JSON from reaching clients.
- `hmp-emotes` now exposes the full-catalog policy as `allowAll` and gives authorized emote editors a
  one-click server allow/remove checkbox beside each favorite star. Allowed rows receive stable generated
  command aliases that can be created or renamed from the directly clickable Server alias column.
- Reworked the release installation documentation around a no-tooling server-owner path, with explicit
  MySQL/MariaDB and Docker setup, working-directory/layout examples, first-boot checks, and troubleshooting.
- Added parallel Windows and Linux dedicated-server instructions, including native paths, shell
  environment setup, filesystem permissions, systemd configuration, and Linux-specific troubleshooting.
- `hmp-characters` now uses the original HogwartsMP wardrobe-style selector, progressively renders
  saved looks through the Framework `Portrait` API, caches matching appearances, and falls back to initials.
- `hmp-characters` now persists new looks from the revisioned post-normalization appearance event,
  preventing portrait cards from capturing an intermediate creator model.
- `hmp-pvp` now owns a configurable server-wide lethal mode, staff commands, late-join targeting/team
  fan-out, a public mode API/event, and full native arbitration for otherwise-undecided hits. `hmp-duels`
  remains higher-priority and non-lethal, then restores the active global presentation after teardown.
- `hmp-activities` now supports expiring, targeted, role-aware session invitations whose acceptance
  revalidates current character, exclusivity, capacity, eligibility, area, and virtual world.

### Known limitations

- Server-validatable MafiaHub identities are pending; asserted identities are suitable only for closed
  testing and must not authorize durable punishments.
- Resource startup and shutdown still use the current synchronous Framework lifecycle.
- Moving native game items across a database-container boundary remains disabled until a recovery
  journal can make that cross-authority operation safe.
- The initial admin resource focuses on moderation and corrective operations; spectate, noclip, and
  god mode are not included.

[0.2.0]: https://github.com/hogwarts-mp/foundations/releases/tag/v0.2.0
[0.1.0]: https://github.com/hogwarts-mp/foundations/releases/tag/v0.1.0
