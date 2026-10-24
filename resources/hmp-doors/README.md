# hmp-doors

`hmp-doors` gives the server final authority over which Hogwarts Legacy doors, gates and logical locks each
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
  "shareUnlocks": false,
  "gateSchedule": "local",
  "heldGates": {},
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
- `"gates": "*"` or an array of gate actor names (see [Gates](#gates));
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

`lock` needs explicit doors or gates: it is rejected on a `locks` or `alohomora` target, and on `"*"`. A
locked door is also emitted as an `unlockAllExcept` entry, so a client too old to honour `lockDoors` leaves
it alone rather than unlocking it under a wildcard allow.

`/doors lock <selector>` and `/doors unlock <selector>` apply the same thing live for testing. They are
diagnostics — nothing re-applies them as cells stream, so persist a rule once you know the selector works.

## Lock levels

A `deny` or `lock` rule naming doors can also set the Alohomora level their padlocks ask for, from 1 to 3:

```json
{ "priority": 100, "action": "lock", "doors": ["BP_Door_Headmaster"], "lockLevel": 3 }
```

The server holds the level for every player through `Doors.set(selector, { lockLevel })`, so the padlock's
callout shows it and the game lets only a player whose Alohomora reaches it cast on the door. Only padlocked
doors carry a level; `/doors list` prints each one's current level, or `key-only` for a padlock only a key
opens. Being the same for everyone, a level cannot follow `match`, so a rule carrying one has none; a player
whose rules unlock the door never meets it. Where several rules give a door a level, the strongest wins, and at
equal priority the higher level. Levels are held when the resource starts and released when it stops.

Lock levels need HogwartsMP `1.10` or newer for `Doors.set` `lockLevel`. On an older host `hmp-doors`
logs a warning at startup and every padlock keeps the level it shipped with.

## Shared unlocks

A host that shares unlocks holds a lock a player opens by key or Alohomora unlocked for every player, under
the door's persistent id. That hold beats every player's policy, so one player able to pick a door a `deny` or
`lock` rule keeps shut would open it for everyone else until the server restarts. `"shareUnlocks": false`, the
default, therefore keeps each unlock in the opener's game, as every older host did. Set it to `true` to share
them; the rules then decide only who may open a door first. The setting is host-wide, and the one `hmp-doors`
found is put back when it stops.

Either way the host raises `doorUnlocked(player, { name, id, path, shared })` for a lock opened by key or
Alohomora, so any resource can react to one directly.

Sharing needs HogwartsMP `1.10` or newer for `Doors.setShareUnlocks`. An older host keeps every unlock
private; asked to share, `hmp-doors` logs a warning at startup.

## Gates

A gate is not a door. Portcullises, the Astronomy rune gate, goblin camp gates and goblin crawl grates are
each their own actor class, so a `doors` rule never matches one and a `gates` rule never matches a door.
Names and path names come from `/doors gates`. Gate rules rank and `match` like door rules; personal grants
are doors only.

| `kind` | What | Lock |
|---|---|---|
| `portcullis` | Clocktower, OuterGate and DungeonA gates | yes |
| `runeGate` | the Astronomy rune-puzzle gate | no |
| `swingGate` | goblin temporary camp gates | no |
| `crawlGrate` | breakable grates over goblin crawl spaces | no |

- `allow` unlocks a gate and leaves it closed: an unlocked portcullis rises as a player walks up to it and
  lowers a second after the last one leaves. Only a portcullis has a lock, so on other kinds it does nothing.
- `"open": true` on an `allow` opens the gate instead, keeping a portcullis raised. On a crawl grate that
  breaks it, which nothing undoes; on the rune gate it skips the puzzle. At equal priority a plain allow
  beats it.
- `deny` withholds an unlock or an open. `lock` closes and locks, beating both, and needs named gates; a kind
  without a lock is closed instead, until a player opens it their own way.
- `"kind"`, one kind or an array, narrows a `"gates": "*"` rule. Without it `"*"` covers every kind, so scope
  any wide `open`. A rule naming gates applies whatever their kind; the server never sees a gate, so only a
  `"*"` rule without `kind` weighs in on a named one.

```json
{ "priority": 1000, "action": "allow", "gates": "*", "kind": "portcullis" },
{ "priority": 500, "action": "lock", "gates": ["BP_HW_ClocktowerPortcullis2"] }
```

`heldGates` holds gates the same for every player through the server's `Gates.set`, whatever their save or
rules say: a held axis beats the rules, and a held lock beats a held open. It maps a selector, an actor name
or a path name when it holds `/` or `:`, to `locked`, `open`, or both:

```json
"heldGates": { "BP_ZZS_TundraGate_2": { "open": true } }
```

They are held when the resource starts, and only the axes the config holds are released when it stops. A
lockless gate held closed still opens for a player who solves or casts at it, until it next streams in.

Most portcullises rise at 06:00 and lower at 20:00 off each client's own clock, which the server's time does
not drive, so two players can see one gate in different places. `"gateSchedule": "freeze"` takes every
portcullis off its clock; the default, `"local"`, leaves the game's schedule running. A frozen portcullis
stays off its clock until it streams in again.

Gate rules need HogwartsMP `1.10` or newer for the client `Gates` builtin; an older client ignores them and
leaves every gate to the game. `heldGates`, `gateset` and `gatesheld` need it for the server `Gates` builtin. On an
older host `hmp-doors` logs a warning for `heldGates` at startup and the commands say they are unavailable.

## API

Server exports:

- `policy.resolve(player)` returns the active character, groups, grants, and resolved policy.
- `policy.sync(player)` and `policy.syncAll()` recompute and push complete client policies. `sync`
  returns `null` and `syncAll` skips a player with no `hmp-core` session yet; `hmp:session:ready`
  syncs them moments later.
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
/doors gates [radius]
/doors gate <open|close|lock|unlock> <GateActorName|path name>
/doors gateset <locked|unlocked|open|closed|release> <GateActorName|path name>
/doors gatesheld
/doors reload
/doors grant <me|nick|#id> <DoorActorName>
/doors revoke <me|nick|#id> <DoorActorName>
/doors grants <me|nick|#id>
/doors clear <me|nick|#id>
```

`list` prints loaded physical actor names to the client console, with a padlocked door's lock level where
the host reports it. The nearby/open actions are diagnostics, not durable policy. Set `enableCommands` to
false outside testing if script APIs are the only desired management surface.

`gates` lists every loaded gate, or those within the radius, with its kind and state; the nearest five go to
chat with their path names. `gate` drives matching gates on your own client only, until they stream in again.
`gateset` holds a gate for everyone through `Gates.set` and `release` lets go of both axes; a hold lasts until
it is released or the server restarts, past a stop of this resource. `gatesheld` lists every gate the server
holds, other resources' included.

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
