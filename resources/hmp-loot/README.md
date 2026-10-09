# hmp-loot

`hmp-loot` replaces the game's own world loot with loot the server places: chests opened with F, moonstone
deposits broken with a spell, and foragables picked up with F. Each lootable is either taken once per
**character** or once in total (**shared**), comes back after its respawn time, and remembers who took it
across reconnects and restarts.

The Framework's `Lootables` builtin does the engine work — spawning the game's own Blueprint on every
client, stocking it, checking each take against what that player sees and adopting the items into the
player's inventory. `hmp-loot` owns the policy: which `hmp-core` character took what, when it respawns, and
what each character is offered when it loads.

The server build must carry the `Lootables` builtin and `World.suppressLoot`. Older builds log an error at
startup and place nothing.

## Configuration

Copy `examples/config/data/hmp-loot.json` to `<server-root>/data/hmp-loot.json`:

```json
{
  "command": "loot",
  "enableCommands": true,
  "adminGroups": [{ "key": "admin", "minimumGrade": 1 }],
  "suppressGameLoot": { "chests": true, "moonstones": true, "foragables": true },
  "lootables": [
    {
      "key": "courtyard-chest",
      "kind": "chest",
      "position": { "x": 366934, "y": -461327, "z": -82700 },
      "yaw": 180,
      "items": [{ "itemId": "Moonstone", "count": 5 }, { "itemId": "Back_002_Common" }],
      "scope": "shared",
      "respawnSeconds": 3600
    },
    {
      "key": "courtyard-eggs",
      "kind": "foragable",
      "position": { "x": 366934, "y": -461527, "z": -82700 },
      "items": [{ "itemId": "AshwinderEggs", "count": 3 }],
      "scope": "character",
      "respawnSeconds": 1800
    }
  ]
}
```

- `suppressGameLoot` switches the game's own chests, moonstones and foragables off (`World.suppressLoot`)
  while the resource runs, and back on when it stops. Families left out, or `false`, keep the game's loot.
  The Overland spawns go from areas that load after startup, so a client that joins sees none.
- `key` names a lootable for good: takes are recorded against it, so renaming one forgets who looted it.
- `kind` is `chest`, `moonstone` or `foragable`; `model` (a Blueprint class path) is optional and
  defaults to a Hogwarts chest, the small moonstone deposit, or the foragable the game uses for the item.
- `items` are `InventoryCatalog` ids. Moonstones and foragables hold plain items only (no gear), and a
  foragable holds one stack. A lootable the builtin refuses is logged and listed as not placed.
- `scope: "character"` (the default): every character may take it once until it respawns. A player is
  offered nothing before a character loads. `scope: "shared"`: the first taker empties it for everyone.
- `respawnSeconds`: seconds from the take until it is back. Leave it out for loot that never comes back.
- A lootable counts as taken from the first item out of it. Whatever is left stays with the taker until it
  respawns.

`HMP_LOOT_CONFIG`, `HMP_LOOT_COMMAND` and `HMP_LOOT_COMMANDS` override the file path, command name and
command enablement. Restart the server after changing the file.

## Commands

`/loot` is gated by `adminGroups` (effective `hmp-core` groups):

| Command | Effect |
|---|---|
| `/loot status` | resource state, placed lootables and live takes |
| `/loot list` | every configured lootable: kind, scope, respawn, whether it is taken or failed to place |
| `/loot reset <key> [characterId]` | end one character's take, or every take of the lootable, so it is back now |

## Server API

```ts
const loot = Imports.get("hmp-loot");

loot.lootables.list();                       // definitions with their Lootables id and shared take
loot.lootables.get("courtyard-chest");
loot.lootables.record("courtyard-eggs", 42); // a character's live take, or null
loot.lootables.reset("courtyard-eggs", 42);  // or reset(key) for every take
loot.lootables.onTaken((take) => {
    // { key, characterId, accountId, takenAt, respawnAt, player, items }
});
loot.status();
```

## Database

One table, `hmp_loot_takes`, keyed by `(lootable_key, character_id)`; a shared take uses character id `0`.
Times are epoch milliseconds. Expired rows are deleted as they expire and at startup; rows of a lootable no
longer in the config are kept, so adding it back remembers its takes.
