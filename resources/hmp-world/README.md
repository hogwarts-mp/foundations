# hmp-world

`hmp-world` owns the server-wide baseline for Hogwarts Legacy's environment and native world
behavior. It applies starting weather, clock, date and season on resource startup, then sends the
configured boundary, population and encounter policy to every client. Policies are re-sent when the
client resource becomes ready, the world becomes ready, and a character finishes loading.

The resource reads and mutates the Framework's replicated environment through the flat `World.*`
properties and setters. Its own `world.environment` export remains the stable Foundations API used
by other resources.

## Configuration

Copy `examples/config/data/hmp-world.json` to `<server-root>/data/hmp-world.json`. The bundled defaults
remove native mount boundaries—including Hogsmeade's no-fly zone—and suppress ambient population and
native enemy encounters:

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
    "nativeEncounters": false
  }
}
```

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
