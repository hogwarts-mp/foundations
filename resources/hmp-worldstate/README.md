# hmp-worldstate

`hmp-worldstate` owns world state that *players change* and that must survive a restart: a keyed,
server-authoritative store persisted in MySQL and pushed to every client. It ships one system,
**repairable objects** — one player's Reparo repairs a broken statue for everyone, one player's blast
breaks it for everyone, and late joiners see the current state. Other resources may register further
systems (lit braziers, solved puzzles, moved props) on the same store.

`hmp-world` is the server's static *baseline* (weather, clock, season, boundaries, population) and stays
config-driven and unpersisted; `hmp-worldstate` is what happened to the world since.

## Repairable objects

Every `PersistentBreakable` the game marks repairable — statues, armour stands, furniture — is keyed by the
game's own object uid (a CRC-32 of the placed location), so every client computes the same key for the same
statue and nothing is negotiated. The native `Breakables` builtin watches the game's repair-done and
fully-broken events and reports only changes the local player caused; the server records the state and
broadcasts it; clients replay it through the game's own repair path (animated) or snap it into place on
join, and re-apply it whenever a cell streams in. Disposable breakables (vases, crates) are not tracked.

The client build must carry the `Breakables` builtin (mod commit `59b3cfa9` or newer). Older clients log a
warning, keep the cached state, and simply do not apply it.

## Configuration

Copy `examples/config/data/hmp-worldstate.json` to `<server-root>/data/hmp-worldstate.json`:

```json
{
  "command": "worldstate",
  "enableCommands": true,
  "adminGroups": [{ "key": "admin", "minimumGrade": 1 }],
  "breakables": {
    "enabled": true,
    "reportLimit": { "limit": 20, "windowMs": 10000 }
  }
}
```

`reportLimit` caps how many repair/break reports one player may send inside `windowMs`; a flood past it is
dropped. `HMP_WORLDSTATE_CONFIG`, `HMP_WORLDSTATE_COMMAND` and `HMP_WORLDSTATE_COMMANDS` override the file
path, command name and command enablement.

## Commands

`/worldstate` is gated by `adminGroups` (effective `hmp-core` groups):

| Command | Effect |
|---|---|
| `/worldstate status` | store state, systems, entry count, synced players |
| `/worldstate list [system]` | entries of a system (default `breakables`) |
| `/worldstate set <system> <key> <value>` | write one entry for everyone |
| `/worldstate delete <system> <key>` | remove one entry |
| `/worldstate clear <system>` | remove every entry of a system; clients reset the objects on next stream-in |
| `/worldstate nearby [radius]` | list nearby repairables with uid and live state in your client console |
| `/worldstate resync` | re-send the whole store to every player |

## Server API

```ts
const worldstate = Imports.get("hmp-worldstate");

worldstate.breakables.get(uid);                 // "broken" | "repaired" | null
worldstate.breakables.list();
await worldstate.breakables.set(uid, "repaired", { actor: player });
await worldstate.breakables.clear();

worldstate.systems.register("braziers", {
    validateValue: (key, value) => value === "lit" || value === "out" || "brazier must be lit or out",
    maxEntries: 500,
    broadcast: true,
});
worldstate.state.get("braziers", "hall-1");
await worldstate.state.set("braziers", "hall-1", "lit", { actor: player });
worldstate.state.subscribe("braziers", (change) => { /* change.previous, change.value, change.deleted */ });
worldstate.state.sync(player);
worldstate.status();
```

Keys are 1–64 characters, values up to 256; a system may add its own validation and an entry cap. Writes
resolve `false` when nothing changed. Rows stored for a system that has not registered yet are kept and
adopted when it does, so a resource may register after the store loads.

Exports are `state`, `systems`, `breakables`, and `status`. The client exports `status`, `state` (cached
reads), and `breakables` (`list()`, `nearby(radius)`).

## Events

| Event | Direction | Payload |
|---|---|---|
| `hmp-worldstate:ready` | client → server | `{}` on client load; answered with a sync |
| `hmp-worldstate:breakable` | client → server | `{ uid, state, cls }` — the local player's own change |
| `hmp-worldstate:sync` | server → client | `{ systems: { [name]: [[key, value], ...] } }` |
| `hmp-worldstate:change` | server → client (all) | `{ system, key, value \| null, by }` |
| `hmp-worldstate:clear` | server → client (all) | `{ system }` |

Systems registered with `broadcast: false` are never pushed to clients.

## Database

`hmp_world_state (system_name, state_key, state_value, updated_by_account_id, created_at, updated_at)`,
primary key `(system_name, state_key)`, created by migration on first start.

## Known limits

- Only objects the game marks repairable are tracked.
- A repair is attributed through the object's own repair record (its instigator), a break through a recent
  local spell; objects broken by NPCs or physics stay client-local.
- A repair interrupted on the caster after it began still completes on everyone else.
