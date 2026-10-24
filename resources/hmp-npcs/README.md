# hmp-npcs

`hmp-npcs` is the Foundation-owned NPC boundary. It exposes the enemy identifiers verified against
the Framework catalog, validates spawn requests, tracks ownership by resource, and destroys a
resource's NPCs automatically when that resource stops.

## Configuration

Copy `examples/config/data/hmp-npcs.json` to `<server-root>/data/hmp-npcs.json` to override the
default limits. `maximumPerResource` may not exceed `maximumManagedNpcs`.

## Server API

```ts
const npcs = Imports.get("hmp-npcs");

const enemy = npcs.spawn({
  resource: "my-gamemode",
  enemyId: "Goblin_Grunt",
  position: { x: 100, y: 200, z: 300 },
  disposition: "hostile",
  ownerId: player.id,
  maxHealth: 250,
  scale: 1.1
});

npcs.catalog.list();
npcs.get(enemy.id);
npcs.destroy(enemy.id, "my-gamemode");
npcs.clear("my-gamemode");
```

Wave composition, encounter behavior, rewards, and boss rules belong to the consuming gamemode.
The catalog documents inert or encounter-dependent entries but does not hide them.

## Movement

A resource walks the NPCs it spawned along paths, with the game's own pathfinding and locomotion on
the client that runs each NPC:

```ts
const guard = npcs.spawn({ resource: "my-gamemode", enemyId: "Poacher_Grunt", position: gate, disposition: "friendly" });

npcs.movement.along(guard.id, "my-gamemode", [
  { x: 100, y: 200, z: 300, wait: 5 },
  { x: 900, y: 200, z: 300, wait: 5, gait: "jog" }
], { loop: "pingpong" });

npcs.movement.to(guard.id, "my-gamemode", { x: 100, y: 200, z: 300 }, { then: "stand" });
npcs.movement.pause(guard.id, "my-gamemode");
npcs.movement.resume(guard.id, "my-gamemode");
npcs.movement.stop(guard.id, "my-gamemode");
npcs.movement.setIdle(guard.id, "my-gamemode", "wander", { x: 100, y: 200, z: 300 });
npcs.movement.get(guard.id); // { state, waypoints, idle, home }
```

- Points are at a player's origin height, as `player.position`. A path has 1 to 64 points, each with
  an optional `wait` in seconds and the `gait` of the leg that arrives there. `loop` is `"once"` (the
  default), `"loop"` or `"pingpong"`; `radius` and `speedScale` tune arrival and speed.
- A new path replaces the running one. A fight the NPC gets into holds the path, which continues once
  it is calm again.
- A `"once"` path ends in its `then` idle (default `"stand"`) at its last point, which becomes its
  home. `setIdle` sets what it does while no path runs: `"native"` (the game's own wander where it
  spawned), `"stand"` (hold at its home) or `"wander"` (roam around it).
- Every call takes the resource that spawned the NPC and is false for any other, for a gone or dead
  NPC, and on a host without NPC movement, where `get` is null. Malformed input throws a `TypeError`.

Movement needs a HogwartsMP host with `NPC.moveAlong`. On an older host every call is false and the
NPC keeps the game's own behaviour.

## Events

```ts
Events.on("hmp:npcs:waypoint", ({ npc, index, lap }) => {
  if (npc.resource !== "my-gamemode") return;
  // reached waypoints[index], before its wait; lap counts completed laps
});
Events.on("hmp:npcs:moveEnded", ({ npc, reason }) => {
  // reason: "arrived", "stopped", "replaced" or "unreachable"
});
```

They forward the host's `npcWaypoint` and `npcMoveEnded` for NPCs this service manages, each with the
NPC's snapshot, whose `resource` is its owner. `"replaced"` comes before the new path's events. A path
a death ends may not be forwarded, because `npcDied` removes the NPC from `hmp-npcs`; watch `npcDied`
for deaths.
