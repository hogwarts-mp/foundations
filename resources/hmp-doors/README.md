# hmp-doors

`hmp-doors` gives the server final authority over which Hogwarts Legacy doors and logical locks each
player may pass. The shipped configuration unlocks every physical door while leaving it closed, which
matches Foundations's open-world default. Remove that rule for vanilla locking or add ranked exceptions.

Physical door actor names and logical `LockDefinition` IDs are deliberately separate targets. A physical
door rule affects whether the player can open that streamed door. A logical lock rule affects game state
such as a scripted gate or quest lock and may not visibly move a physical door.

## Configuration

Create `data/hmp-doors.json` or copy the supplied example:

```json
{
  "command": "doors",
  "enableCommands": true,
  "adminGroups": [{ "key": "admin", "minimumGrade": 1 }],
  "rules": [
    { "priority": 1000, "action": "allow", "doors": "*" },
    { "priority": 500, "action": "deny", "doors": ["BP_Door_Headmaster"] },
    {
      "priority": 100,
      "action": "allow",
      "doors": ["BP_Door_Headmaster"],
      "match": { "groups": [{ "key": "staff", "minimumGrade": 1 }], "groupMode": "any" }
    }
  ]
}
```

Lower priority numbers are stronger. At an equal priority, `lock` beats `deny`, which beats `allow`. A
personal grant beats all three. A rule targets exactly one of:

- `"doors": "*"` or an array of physical actor names;
- `"locks": ["LockID"]` for logical/scripted locks;
- `"alohomora": true` for the native Alohomora master policy.

`match.groups` uses effective `hmp-core` groups. Job memberships therefore work through their projected
`job:<id>` groups without requiring `hmp-jobs`. `groupMode` defaults to `any`; use `all` when every listed
membership is required. Rules without `match` apply to everyone.

The client passes physical policy to the Framework's streaming-aware `Doors.setPolicy()`, so it applies
again as world cells load; Foundations does not poll nearby actors. An allow unlocks a door but never forces
it open.

## Locking a door

`deny` only withholds an unlock, leaving whatever state the game shipped — for a door vanilla leaves open,
that is not a lock. `lock` actively locks, calling the game's own `ALockable::Lock`:

```json
{
  "priority": 100,
  "action": "lock",
  "doors": ["/Game/Maps/Hogsmeade/Sub_A.Sub_A:PersistentLevel.BP_Door_Template2"]
}
```

A `doors` entry holding `/` or `:` matches the actor's full asset path; anything else matches its name.
Prefer a path whenever `list` shows the name more than once — a bare name locks *every* placement carrying
it. Get the path from `/doors list`, which echoes the nearest five doors into chat with each path on its
own line, because the F8 console cannot be copied from. Every match still goes to the console and to
`logs/HogwartsMP.log`, so widen the radius and read there when five is not enough.

`lock` needs explicit doors: it is rejected on a `locks` or `alohomora` target, and on `"*"`. A locked door
is also emitted as an `unlockAllExcept` entry, so a client too old to honour `lockDoors` leaves it alone
rather than unlocking it under a wildcard allow.

`/doors lock <selector>` and `/doors unlock <selector>` apply the same thing live for testing. They are
diagnostics — nothing re-applies them as cells stream, so persist a rule once you know the selector works.

## API

Server exports:

- `policy.resolve(player)` returns the active character, groups, grants, and resolved policy.
- `policy.sync(player)` and `policy.syncAll()` recompute and push complete client policies.
- `grants.list/grant/revoke/clear(player, doorName?)` manage character-scoped physical-door exceptions.
- `status()` reports rule, synchronization, and lifecycle state.

Policies refresh on client readiness, core session/character changes, and group changes. Grants are stored
under the active character's `hmp-doors:grants` metadata key and do not leak between characters.

## Closed-test command

Members of one configured `adminGroups` entry may use:

```text
/doors status
/doors list [radius]
/doors label [radius]
/doors label off
/doors lock <DoorActorName|/Game/...asset path>
/doors unlock <DoorActorName|/Game/...asset path>
/doors unlock-nearby [radius]
/doors open-nearby [radius]
/doors reload
/doors grant <me|nick|#id> <DoorActorName>
/doors revoke <me|nick|#id> <DoorActorName>
/doors grants <me|nick|#id>
/doors clear <me|nick|#id>
```

`list` prints loaded physical actor names to the client console. The nearby/open actions are diagnostics,
not durable policy. Set `enableCommands` to false outside testing if script APIs are the only desired
management surface.

`label` floats the nearest door's actor name in the world, rendered as `[2.4m] BP_Door_Name`, so names can
be read while walking rather than matched up against a console dump. It labels one door at a time because
`Hud.showPrompt` holds a single prompt; `off` ends it, as does stopping the resource.

An actor name is an `FName`, unique only within its Outer, so streamed sublevels can repeat one — and both
`setPolicy` and `setUnlocked` match on that name and act on *every* door carrying it. When a scan sees the
same name more than once the label appends the level, `[2.4m] BP_Door_Template2 (Sublevel_A)`, and `list`
prints each door's full asset path beneath its row. Use those to tell placements apart before writing a
rule; a rule naming a repeated door affects all of them.

Placement prefers each door's own `x`/`y`/`z`, which `Doors.list` reports on client builds carrying the
door-position change. Against an older client those fields are absent and the anchor is rebuilt from the
player instead: the mod computes the bearing as `atan2(dy, dx) - yaw`, which adding the yaw back inverts
exactly, but the distance is then a straight-line measure standing in for a ground-plane radius and the
height is the player's own Z plus 120cm rather than the door's. The fallback holds up while standing next
to a door and drifts for one well above or below the player.

Chests are not managed by this resource. Chest opening and loot authority require a separate design that
coordinates native save state and Foundations inventory semantics.
