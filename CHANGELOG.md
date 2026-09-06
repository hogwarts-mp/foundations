# Changelog

All notable HMP Foundations changes are recorded here. The project uses a lockstep pack version and the
pre-`1.0.0` policy documented in [COMPATIBILITY.md](COMPATIBILITY.md#version-policy).

## [Unreleased]

### Added

- HogwartsMP ambient types expose server-side player gear slots, equipped and available items,
  equip/unequip operations, the `playerGearChanged` event, and matching local-player gear probes.
- New `hmp-business` resource: player-run businesses composed from `hmp-jobs`, `hmp-banking` and
  `hmp-shops` without changing any of them. A business is one job and its organization account and
  may run any number of counters, each registered with `hmp-shops` as `business:<business>:<counter>`
  with its own position, vendor body, offers and persistent stock. Employees holding the job
  permission `shop.manage` use the management menu to set prices within configured bounds, restock
  from their inventory, withdraw and transfer stock, add, retire and restore offers, open and close
  counters, change the staffing policy (`always`, `staffed`, `kiosk`) and vendor body, and read the
  books. A per-business till moves purchases from the buyer's bank account into the organization
  account in one bank transfer keyed by the shop reference; an optional house cut pays a treasury
  once per purchase. `staffed` counters open only while an employee is on duty within reach of the
  counter and show the vendor body otherwise; an optional surveyed clock-in zone per counter toggles
  duty. Every change is written to a ledger with actor, before, after and reason. Administrators
  create businesses and place counters through `/business` (gated by configured groups) or the API,
  and `data/hmp-business.json` can seed businesses on first start; the example declares Pippin's.
  Buybacks are off by default; when `prices.buybacks.enabled` is set, the shop pays a per-offer
  share (capped by `maxRatio`) of the item's server-owned reference value rather than an owner-set
  price, and `shop.manage` holders may never sell to their own counters.
- `hmp-inventory` item definitions accept a `referenceValue`, the server-owned worth of one unit.
  Native items take the host catalog's `economyValue` when it is exposed; custom items declare it.
- `hmp-webhooks` adds optional server-only named destinations, bounded queues, timeout and retry
  handling, a Discord provider, and migrated gauntlet, activity-completion, and advisory spell-cast
  relays. Endpoint URLs can remain process-environment secrets, and delivery never gates gameplay.
- `hmp-inventory` gains a `startingItems` config list, granted once per character the first
  time it loads after being created. Entries are a bare item name or
  `{ name, amount, metadata }`, resolve through the same registry as `inventory.add` (custom
  rows, native aliases, and raw native ids all work), and are queued on
  `hmp:character:created` then applied after `hmp:character:loaded`. Existing characters are
  never touched; unknown or non-fitting items are logged and skipped.
- `hmp-spells` persists all four spell diamonds per character, capturing assignments from the native
  spell menu and client API and restoring them on reconnect, character switching, and world loading.
- Spell providers and stable `provider:spell` slot references support registered modded gameplay
  names through the native HUD, plus explicit API casting of plugin-owned spell records. Existing
  raw gameplay names and record paths are normalized without clearing stored assignments.
- `hmp-interact` registrations can own a replicated Framework `Character`: a dressed, stationary human
  built from an allowlisted registry id, standing at the zone's own position. Character prompts default
  to chest height and an optional `label` draws a nameplate; the README lists the accepted ids.
- `hmp-shops` forwards an optional `interaction.character` to `hmp-interact`, so a shop registers its
  vendor body together with its stock, and reads data-declared shops from `data/hmp-shops.json`. The
  example config places a potion vendor (Parry Pippin) on the Hogsmeade high street with limited stock.
- Player Administration shows the target's yaw beside their position.

### Changed

- `hmp-jobs` caps employment actions at the actor's own grade. An employee acting through their
  job may only hire below their grade, move employees below them to grades below them, and dismiss
  employees below them; ties are refused. Calls that pass no `actor`, or are owned by `hmp-admin`,
  are exempt so an admin can still seat the first Head. Refused attempts throw `HMP_JOBS_RANK` and
  are written to the ledger as `denied` rows, and the management menu hides grades and greys out
  employees the manager cannot act on.
- Active characters default to one spell loadout when no personal override or applicable rule sets
  the count. `loadouts.unmanage()` clears the personal override and resumes the rule/default count;
  it no longer leaves a previous character's native loadout perks in place.

### Fixed

- Client assignment saves are acknowledged without replaying native slot writes, avoiding duplicate
  assignment sounds and invalid icons while the spell menu is open. Character restoration remains
  separate from user assignment events.

### Upgrade notes

- Update the HogwartsMP client alongside Foundations for native `spellAssignment` events, live-slot
  reads, and restoration event suppression. Foundations adds no custom spell HUD or casting key bindings.
- Character bodies need a HogwartsMP client and server with the `Character` entity (mod commit
  `ae40d769369025738266235899f9a27ff2ac1f08`; nameplate heights follow mod commit
  `49cb74a45cdeb7b30e0d7d4980f7eb935604671f`).
- `player.location().yaw` read `-0.0` before HogwartsMP mod commit
  `4431e1e8e046c4032ba2fe16f9b06288058cfe03`; the admin Yaw row needs that server build.

## [0.3.0] - 2026-09-02

### Changed

- Set the pack, all twenty-four resources, and internal dependency pins to lockstep version `0.3.0`.
- All twenty-four resource manifests now use `serverScripts` and `clientScripts` lists, following
  HogwartsMP mod commit `b85eecf409c59179ef836d613b3a3766f01ed593`. Client resources explicitly declare
  their built client bundle and supporting pages, fonts, icons, and emote catalog in `mafiahub.files`.
  Fields follow the consistent ordering from mod commit `5d99c52f033a5d1b1748ea56a8842b89c33c7987`,
  with scripts and files first and priority last.
- The release check validates the new manifest fields and uses client/shared script lists when
  checking the client dependency graph.

### Added

- `hmp-characters` restores the four cosmetic gear items that vanilla grants during `WEK_01` when a
  character is created. The identified, unworn defaults are configurable through `startingGear`.
- `hmp-npcs` as the Foundation-owned, Framework-verified enemy catalog and resource-scoped NPC spawn,
  ownership, limit, death-tracking, and cleanup service.
- `hmp-doors` gains an `action: "lock"` rule that actively locks a physical door, where `deny` only
  withholds an unlock. `lock` beats `deny` and `allow` at an equal priority; a character grant beats
  `lock`. It is rejected on `locks` and `alohomora` targets and on `"*"`.
- `hmp-doors` rules may target a door by asset path: a `doors` entry containing `/` or `:` matches the
  path rather than the actor name. Names are `FName`s that streamed sublevels repeat, so a name-based
  rule applies to every placement carrying it.
- `hmp-doors` diagnostics for finding those paths — `/doors label`, a chat echo of the nearest doors from
  `/doors list`, and `/doors lock|unlock <name|path>`, which reports how many doors matched.

### Fixed

- `hmp-spawn` uses the actual `Overland` world for the default and example Hogwarts destination.
  The example's former `areaId: "Hogwarts"` hid the only destination and left the selector blank.
  The selector now refreshes when location context arrives or changes, explains when no destinations
  are available, and ignores late refreshes after spawning starts or the player disconnects.
- `hmp-inventory` now counts native (in-game) holdings in the inventory view's `usedSlots` and `weight`,
  so the bundled UI header reflects everything on screen. A character carrying only game items showed
  `0 / N slots` and `0.0 / N weight` even with items visible. The custom-container weight cap enforced
  on `inventory.add` is unchanged.

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

### Upgrade notes

- In existing `data/hmp-spawn.json` files, change the castle-grounds destination's `areaId` from
  `"Hogwarts"` to `"Overland"`, then restart the server and reconnect. Existing configuration files
  are not replaced automatically by a pack update.
- Update the HogwartsMP server and clients together with the matching Framework support for script
  roles and resource containers before installing this pack. Older loaders that only understand
  `server` / `client` entries cannot start these manifests. Existing `fw://resources/…` URLs are unchanged.
- The `hmp-doors` lock and path features need a newer HogwartsMP client. Against an older one a `lock`
  rule degrades closed rather than open, but path selectors match nothing and `/doors lock` fails, so
  keep those rules out of a deployment until its clients are updated.

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

[0.3.0]: https://github.com/hogwarts-mp/foundations/releases/tag/v0.3.0
[0.2.0]: https://github.com/hogwarts-mp/foundations/releases/tag/v0.2.0
[0.1.0]: https://github.com/hogwarts-mp/foundations/releases/tag/v0.1.0
