# hmp-admin

`hmp-admin` is Foundations's server-authoritative moderation and recovery resource. It provides a
staff menu built from `hmp-ui`, capability-based access through `hmp-core` groups, durable warnings
and identity bans, corrective actions across Foundations resources, and a persistent audit trail.

Open it with `/admin`. No privileged action is exposed as a client event: selections return to the
server and are authorized again before the action begins. An audit row is written before every
mutation and then marked completed or failed.

## Closed-test setup

Until the MafiaHub-backed verified identity provider is ready, configure a temporary secret in the
server process:

```text
HMP_ADMIN_BOOTSTRAP_SECRET=<a unique random secret of at least 16 bytes>
```

Staff without a verified admin identity can enter this secret in the masked `/admin` prompt. Access
exists only for that player connection and is discarded on disconnect or resource restart. The
secret is read only from the environment, is never stored in MySQL or configuration files, and
must not be sent through chat. Remove the environment variable once real identities are available.

Do not enable `HMP_ADMIN_UNSAFE_ASSERTED_BANS` for the test. Asserted fallback identities are not
stable enough for durable bans; staff can still warn, freeze, kick, and inspect those players.

## Capabilities

The default `admin` group grants capabilities cumulatively:

| Grade | Capabilities |
|---:|---|
| 1 | View players, kick, go to/bring, send to a map, freeze/release, revive, warn, announce, no-clip |
| 2 | Groups, employment, inventory, player transmog, personal spell grants, banking, treasury inspection, audit history, environment controls |
| 3 | Verified-identity bans and pending bank reconciliation |

Production access requires a `verified` identity by default. Once identities are live, assign a
staff account its role through a trusted server-side resource:

```ts
const Core = Imports.get("hmp-core");
await Core.groups.setAccount(accountId, "admin", 2, {
    source: "staff-provisioning",
});
```

The role mapping can be changed in `data/hmp-admin.json` with `roleRules`. Each rule has a group,
minimum grade, and capability list. `"*"` grants all known admin capabilities. The resource also
accepts `HMP_ADMIN_COMMAND`, `HMP_ADMIN_REQUIRE_VERIFIED`, and `HMP_ADMIN_CONFIG`.

Every group named in `roleRules` is a staff group, and the Groups action holds it to a hierarchy.
An administrator can change a staff group only for a player whose grade in it is below their own,
only to a grade below their own, and never on their own account. A grade-3 admin can make grade-2
admins and demote them, but cannot make another grade-3 or touch a grade-4. Other groups, such as
houses or prefects, stay open to anyone with `admin.groups`. If another resource gates staff tools
on a group that `roleRules` does not name, for example an `adminGroups` entry keyed `staff`, list it
in `protectedGroups` so it gets the same hierarchy:

```json
{ "protectedGroups": ["staff"] }
```

A session unlocked with the bootstrap secret is exempt. Use it, or a trusted server-side resource
as shown above, to appoint the highest grade.

## Tester-facing tools

- Connected-player inspection: account, character, identity trust, groups, world, game area/region, ping, position,
  and administrative freeze state.
- Moderation: durable warnings, kick, verified-identity timed or permanent bans, ban review/revoke.
- Intervention: acknowledged streamed go-to/bring, acknowledged travel to another map or intro place,
  and Framework-authoritative freeze/release. A frozen player's own input is stopped too, so they stay
  put on their screen; camera look still works. A dead player can be revived where they lie, at full
  health and with no reload.
- Staff movement: audited, server-authorized no-clip from the main menu, with camera-relative WASD,
  Space/Ctrl vertical movement, Shift boost, Alt slow movement for precise positioning, collision
  bypass, and protected landing: leaving no-clip on the ground or in mid-air costs no health. While
  flying the admin is hidden from every other player (body, nametag, minimap blip) by the server, and
  can optionally be hidden from their own screen too.
- World environment: audited global weather, season, calendar date, 24-hour time, and clock-speed controls, including a
  searchable dropdown of 34 known native weather profiles and a confirmation-gated reset to the
  configured `hmp-world` baseline. A custom live or baseline profile is added to the dropdown
  automatically. These runtime changes are not persisted and return to the configured baseline on
  server restart.
- Corrections: server-filtered, searchable custom/native inventory items, persistent player transmog from the
  Framework's 151 allowlisted human CharacterDefinitions, and spell grants,
  account/character groups, employment, and personal bank credits/debits in Galleons or another
  registered currency. Native items granted by an administrator are identified by default. Revoking
  a personal spell grant does not override a spell allowed by policy rules.
- Recovery: inspect and explicitly complete, compensate, or fail pending bank transactions.
- Audit: recent pending, completed, and failed actions with actor, target, reason, and error.

Standalone god mode and spectating are intentionally absent. Inventory corrections are limited to definitions
registered with `hmp-inventory`; native entries are routed through the Framework's authoritative catalog.
The inventory editor searches that catalog on the server first and sends at most 32 exact choices to the
client, keeping the dialog below the Framework event-payload limit even with thousands of native items.

No-clip tuning and movement keys can be overridden in the `noclip` object in `data/hmp-admin.json`:

```json
{
    "noclip": {
        "speed": 4500,
        "boost": 3,
        "slow": 0.25,
        "tickMs": 11,
        "hide": true,
        "hideLocal": false,
        "movement": {
            "forward": "w", "back": "s", "left": "a", "right": "d",
            "up": "space", "down": "ctrl", "boost": "shift", "slow": "alt"
        }
    }
}
```

`speed` is in cm/s. `boost` multiplies it while the boost key is held, and `slow` (from `0.05` to
`1`) while the slow key is held; slow wins when both are held. Set `"hide": false` to keep the admin
visible to other players while flying; a server without `player.setVisible` always does. Set
`"hideLocal": true` to also hide the admin's body, wand, and held prop on their own screen while
flying, which keeps the falling animation out of view. It needs HogwartsMP `1.9` or newer
(`LocalPlayer.setVisibility`) and is restored when no-clip ends.

The protected landing needs a HogwartsMP host with `LocalPlayer.resetFall`. No-clip moves the admin
in short teleports, and the game skips a landing's fall damage only after a teleport of more than
1 m, so it counts the flight as a fall. The landing then reads about the height gained since no-clip
began plus the real drop, and past 16 m the game kills outright, invulnerable or not. On a host
without `resetFall`, leaving no-clip on a roof 20 m above where it began, or 10 m up in the air,
still kills the admin.

Revive player is offered while the target is dead and stands them up through the game's own get-up,
granted with `admin.freeze`. It needs a HogwartsMP host with `player.revive`; on an older host it
reports that the host cannot revive. A death the server respawns on its own (server.json
`"mod": { "autoRespawn": true }`, the default) has its respawn ordered as the player dies, and a
revive cannot overtake it, so Revive stands up a death held with `"autoRespawn": false` or a
resource's `player.setAutoRespawn(false)`; otherwise it reports the respawn already on its way.

Send to a map loads another map on the target's client, granted with `admin.teleport`; pick yourself
in Connected players to go there. It offers Overland, the intro's Gringotts lobby, vault and
cliffside (places the game builds from several maps), or any map by package path: a dungeon such as
`/Game/Environment/Azkaban/Maps/Azkaban_Dungeon`, or a mod's `/<ModFolder>/Maps/<MapName>`, which the
player must have installed. An optional PlayerStart tag stands them at it, and on Overland a
dungeon's name lands at its entrance. The menu waits until the player is playable there, then
reports the area they arrived in, or why they did not: their client lacks the map, a newer travel
replaced it, or it timed out. Players only see others in the same map. It needs a HogwartsMP host
with `player.travelToMap`, and `player.travelToPlace` for the intro places; on an older host it
reports that the host cannot travel.

## Suggested closed-test feedback

Ask testers whether they could identify the correct player, understand the consequence of each
action before confirming, recover from a mistake, and find enough audit detail afterward. Also
record any action they expected but could not perform, confusing terminology, overly broad role,
or situation where the menu lost context after a player disconnected.

## Exports

- `permissions`
- `players`
- `actions`
- `moderation`
- `audit`
- `noclip`: `isActive(player | playerId)` reports whether administrator no-clip is switched on for a
  connected player, so other resources can react without tracking it themselves.
- `ui`
- `status`
