# hmp-world

`hmp-world` owns the server-wide baseline for Hogwarts Legacy's environment and native world
behavior. It applies starting weather, clock, date and season on resource startup, then sends the
configured boundary, population, jump and sprint policy to every client. Policies are re-sent when the client
resource becomes ready, the world becomes ready, and a character finishes loading. Enemy encounters
are the server's: `encounters` goes to `World.setEncounterPolicy`, which the host applies to every
client, including late joiners.

The resource reads and mutates the Framework's replicated environment through the flat `World.*`
properties and setters. Its own `world.environment` export remains the stable Foundations API used
by other resources.

## Configuration

Copy `examples/config/data/hmp-world.json` to `<server-root>/data/hmp-world.json`. The bundled defaults
remove native mount boundaries—including Hogsmeade's no-fly zone—and suppress ambient population and
the Overland's enemy encounters:

```json
{
  "environment": {
    "weather": "Clear",
    "time": { "hour": 9, "minute": 0, "second": 0, "scale": 1 },
    "date": { "day": 1, "month": 9, "year": 0 },
    "season": "autumn"
  },
  "policy": {
    "removeBoundaryVolumes": true,
    "ambientPopulation": false,
    "encounters": "suppressed",
    "playerCollision": false,
    "fastTravel": true,
    "keepHealthOnTravel": false,
    "jump": true,
    "sprint": true
  }
}
```

`encounters` decides who spawns the Overland's enemy camps and roaming world events: `"suppressed"`
(the default) spawns none, and `"server"` spawns them on the server as NPCs every player shares. What
happens to the game's other enemies depends on the host. A HogwartsMP host newer than `1.9.2` keeps
every native spawner shut under both policies, quest ones included, so no client spawns an enemy of its
own: quest fights, the waves a dungeon's script opens and the beast-cage rescue's poachers never spawn,
and a quest whose objective waits on defeating them stalls at that step. HogwartsMP `1.9` through
`1.9.2` leaves them to the game, which spawns them on one client alone, seen only by that player.

`playerCollision: true` makes players block each other's movement on every client, late joiners
included (`World.setPlayerCollision`). Only a player's own movement is blocked: nobody can push anyone,
and NPCs, spells and the world are unaffected. Two players who end up inside each other pass through
until they separate, and hidden, mounted, dead, disillusioned and animal-form players never block. The
default `false` lets players walk through each other, as before. Another resource can take one player
out of it with the host's `player.setCollidable(false)`. It needs a HogwartsMP host with
`World.setPlayerCollision`; an older host ignores it and players keep walking through each other.

`fastTravel: false` stops players fast travelling from their own map (`player.setFastTravelEnabled`):
their game dims every Floo flame and refuses a pick. Story travel and the server's `player.fastTravel`
still go. It reaches each player as they connect, and everyone online when `policy.set` changes it;
stopping `hmp-world` gives online players their fast travel back. The default `true` leaves it as
before. To refuse only some trips, another resource handles the host's `playerFastTravelRequest` event
and returns `false`: every handler runs, and any `false` refuses. It needs a HogwartsMP host with
`player.setFastTravelEnabled`; an older host ignores it, raises no `playerFastTravelRequest`, and
players keep fast travelling.

`keepHealthOnTravel: true` carries each player's health over a map load, such as entering or leaving a
dungeon, instead of the full health a fresh body starts with (`player.setKeepHealthOnTravel`). A
respawn after a death still starts full. It reaches players as `fastTravel` does, and stopping
`hmp-world` switches it off for those online. The default `false` keeps the full-health reset. It needs
a HogwartsMP host with `player.setKeepHealthOnTravel`; an older host ignores it and every map load
still heals to full.

`jump: false` and `sprint: false` keep players from jumping or sprinting (`LocalPlayer.setJumpEnabled`,
`LocalPlayer.setSprintEnabled`): the button does nothing, a jump already in the air lands normally,
and a running sprint stops. Each client takes them as `hmp-world`'s own hold, so a hold another resource
takes stays, and the host drops `hmp-world`'s when it stops. Both default to `true`, as before.
`policy.set` changes them for everyone; a resource that needs them off for its own reasons, such as for
one player, calls those `LocalPlayer` functions itself and gets a hold of its own, dropped when it stops.
They need a HogwartsMP host with `LocalPlayer.setJumpEnabled` and `setSprintEnabled`; an older host
ignores them and players keep jumping and sprinting.

`time.scale` is in-game minutes per real second: `1` gives a 24-minute in-game day and `0` freezes
the clock. `date.year: 0` preserves the game's native year. Seasons accept `spring`, `summer`,
`autumn`, `winter`, or `0` through `3`. Weather names are passed to Hogwarts Legacy as configured.

Set `HMP_WORLD_CONFIG` to use a different JSON path. Paths are relative to the server working
directory. Restart the server after changing the baseline.

## Server API

```ts
const world = Imports.get("hmp-world");

world.environment.state();
world.environment.setWeather("LightRain_01");
world.environment.setTime(17, 30, 0);
world.environment.setSeason("winter");
world.environment.setTimeScale(0);
world.environment.reset();

world.policy.current();
world.policy.set({ removeBoundaryVolumes: false });
world.policy.reset();
world.policy.sync(player);
```

Runtime changes are global but intentionally not persisted. `reset()` returns to the JSON baseline;
a server restart does the same. Gamemodes may use these calls for temporary policy changes without
becoming the owner of the normal server environment.

Server exports are `environment`, `policy`, and `status`. The client exports `status` plus
`policy.current()` and `policy.restore()` so a gamemode can return from a temporary native-world
override to the latest server-authored policy.
