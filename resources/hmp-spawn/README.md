# hmp-spawn

`hmp-spawn` completes the Foundations login path: account → character → world. After
`hmp-characters` selects a character, this resource offers configured destinations and that
character's last saved position, then performs a server-issued streamed teleport.

The streamed teleport is the HogwartsMP Framework's supported path. It roots destination streaming,
waits until the area is ready, optionally performs capsule-aware ground placement, moves the pawn,
and reports a structured completion through `playerTeleportComplete`. The resource accepts success
only with the client-observed final transform and saves that landing point rather than the requested
coordinates. The client keeps controls locked and the screen faded until that success arrives;
failed or timed-out destinations return the player to selection.

## Persistence

Last location is stored in `hmp-core` character metadata under `hmp-spawn:last-location`. It is saved:

- after a successful spawn,
- periodically while the character is in the world,
- before character unload or disconnect.

A character that has not completed spawning cannot overwrite its saved position with a staging or
selection-screen location.

## Configuration

Optional `data/hmp-spawn.json`:

```json
{
  "showSelector": true,
  "allowLastLocation": true,
  "saveLastLocation": true,
  "defaultLocation": "hogwarts",
  "teleportTimeoutMs": 120000,
  "autoSaveMs": 60000,
  "worldSpawn": null,
  "respawnAtSpawn": false,
  "locations": [
    {
      "key": "hogwarts",
      "label": "Hogwarts",
      "description": "Return to the castle grounds.",
      "areaId": "Overland",
      "x": 366784,
      "y": -461527,
      "z": -82610,
      "yaw": 90,
      "snapToGround": true,
      "groundSnapDistance": 2000
    }
  ]
}
```

Environment overrides: `HMP_SPAWN_CONFIG`, `HMP_SPAWN_SELECTOR`,
`HMP_SPAWN_LAST_LOCATION`, `HMP_SPAWN_SAVE_LOCATION`, and `HMP_SPAWN_DEFAULT`.

If `showSelector` is false, the character spawns at their last location when it is in the player's
current area, and otherwise at `defaultLocation`. When neither fits, for example before the client
has reported its area, the selector opens instead and fills in once the area is known.

Set `areaId` on configured destinations; a scoped destination is shown only while the player is in
that game-authored coordinate space. `regionId` is a sub-area within it that changes as a player
walks, such as `HOG_EntranceHall` inside `Overland`; set it only to offer a destination from that
region alone. Saved locations record both, but match on `areaId` only, so a character saved in the
Entrance Hall is offered Last Location anywhere in `Overland` and never from a different map. During
world travel, `playerLocationChanged` supplies the last valid snapshot before location becomes unavailable.

`areaId` is the game's world/map name: the castle grounds use `Overland`, not `Hogwarts`.
The selector refreshes when location context arrives or changes. While context is unavailable it
shows a waiting message; if the current area has no destinations it explains that none are configured.

## Spawn points

A connecting player's client loads into the world before they choose a character, so it cannot load
them at that character's destination; the teleport above always takes them there. Two options use the
host's spawn points around it, both off by default:

- `worldSpawn` names a configured `Overland` location (or one without `areaId`). At start, hmp-spawn
  makes it the server's spawn point with `World.setSpawn`: every connect load stands players there
  instead of in the house dormitory, and a respawn without a position lands there when no player spawn
  point applies. The load takes the location's coordinates and `yaw` (default 0) as they are, without
  `snapToGround`. Stopping hmp-spawn puts back the spawn point it found.
- `respawnAtSpawn: true` makes each character's landing their player's spawn point with
  `player.setSpawn`, so a respawn without a position, like the automatic one after a death, stands them
  where they came into the world rather than at the world's spawn or in the dormitory. Choosing another
  character clears it until that one lands, and a landing outside `Overland` clears it. Leave it off
  when another resource sets players' spawn points.

Both need a HogwartsMP host with `World.setSpawn` and `player.setSpawn`. On an older host,
`worldSpawn` logs a warning and players load into the dormitory, `respawnAtSpawn` does nothing, and
the selector, last location and teleport work as before.

## Exports

```js
const Spawn = Imports.get("hmp-spawn");

const remove = Spawn.locations.register({
    key: "ministry",
    label: "Ministry of Magic",
    description: "For Ministry staff.",
    x: 100,
    y: 200,
    z: 300,
    resource: "hmp-ministry",
});

await Spawn.ui.open(player);
await Spawn.spawn(player, "ministry");
```

Registered locations are automatically removed when their owning resource stops. Built-in configured
locations cannot be removed at runtime.

## Lifecycle events

- `hmp:spawn:started` — `{ session, character, location, requestId }`
- `hmp:spawn:complete` — `{ session, character, location, completion }`; `location` contains the observed landing transform
- `hmp:spawn:failed` — `{ session, character, location, status, message }`

Framework teleport status `0` is success. Other statuses represent superseded, unavailable,
world-changed or teleport-failed requests; `hmp-spawn` uses status `6` for its own timeout.
