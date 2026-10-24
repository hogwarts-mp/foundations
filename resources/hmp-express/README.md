# hmp-express

`hmp-express` runs the Hogwarts Express from the server. Under a host with `World.hogwartsExpress` the
game's own timetable is off on every client, so without a script the train never comes. This resource
puts a timetable back: at each departure it stands the train at the start of the track, south of
Hogsmeade, runs it to each configured stop, waits there, and sends it off the far end. The server runs
the train and every client draws the game's own engine, coal car and carriages at the same spot, late
joiners included.

Out of the box it keeps the game's own timetable (10:00 on Monday, Wednesday and Friday, 21:00 on
Saturday) and drives straight through at the game's own speed, as the game does. It needs no admin and
no command.

It needs HogwartsMP `1.10` or newer for `World.hogwartsExpress`. An older host logs an error at startup,
reports `degraded` and runs nothing; its clients keep the game's own timetable, each on its own.

## Configuration

Copy `examples/config/data/hmp-express.json` to `<server-root>/data/hmp-express.json`, or set
`HMP_EXPRESS_CONFIG` to another path:

```json
{
  "enabled": true,
  "departures": [
    { "time": "10:00", "days": ["monday", "wednesday", "friday"] },
    { "time": "21:00", "days": ["saturday"] }
  ],
  "stops": [{ "at": "hogsmeade", "dwellSeconds": 120 }],
  "speed": 20,
  "accel": 0.5,
  "decel": 0.7,
  "year": 1891
}
```

- `enabled: false` leaves the train alone, for another script to run; the `train` export then only reads it.
- `departures`: in-game times on the server clock (`"HH:MM"`), each on the weekdays in `days`, or every
  day when `days` is left out. The clock is `hmp-world`'s: at its default `time.scale` of 1 a day lasts 24
  real minutes, and a frozen clock (`scale: 0`) runs no departures. A clock set forward by more than an
  hour (or three seconds of a fast clock) skips the departures in between. A departure while the train is
  still out is skipped. `[]` runs no timetable; the `train` export still works.
- `stops`: where the train stands on the way, in track order, each for `dwellSeconds` real seconds
  (default 120, up to 3600). `at` is a stop id (the host has `hogsmeade`, along the station's platform) or
  a `t` from 0 to 1 along the track. `[]` drives straight through, as the game does. A stop the host does
  not know, or one not past the stop before it, leaves the resource `degraded` with nothing run.
- `speed` is the cruise in m/s (above 0, up to 60; the game's own is 20), `accel` and `decel` the
  pulling away and braking in m/s² (above 0, up to 10). A stop closer than the braking distance brakes harder.
- `year`: the day of the week comes from the server's date; while `hmp-world` keeps the game's own year
  (`date.year: 0`) it is taken from this year.

The file is read at startup; restart the server after changing it.

## Server API

```ts
const express = Imports.get("hmp-express");

express.train.get();        // { spawned, moving, departing, t, speed, target, seconds }, or null on an older host
express.train.stops();      // [{ id: "hogsmeade", t: 0.31 }]
express.train.run();        // the configured route now, as a departure would; false while a train is out
express.train.spawn(0);
express.train.moveTo("hogsmeade", { speed: 15 });
express.train.depart();
express.train.halt({ decel: Infinity });
express.train.despawn();
express.status();           // { state, lastError, departures, stops, train, run, uptimeMs }
```

`spawn`, `moveTo`, `depart`, `halt` and `despawn` are the host's own calls and return false when it
refuses one. Each that succeeds takes the train off the timetable: the caller drives it from there, and
the next departure runs once the train is gone. All are false while the resource is disabled, degraded or
stopped. `status().run` is the timetabled run the train is on: the departure that sent it, the stop it is
running to or standing at, and while it stands there, when it goes on.

The host's `trainSpawned`, `trainStopped` and `trainEnded` events reach every resource. Stopping
`hmp-express` removes a train it spawned; one another script spawned stays.
