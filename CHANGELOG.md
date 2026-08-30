# Changelog

All notable HMP Foundations changes are recorded here. The project uses a lockstep pack version and the
pre-`1.0.0` policy documented in [COMPATIBILITY.md](COMPATIBILITY.md#version-policy).

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

[0.1.0]: https://github.com/hogwarts-mp/foundations/releases/tag/v0.1.0
