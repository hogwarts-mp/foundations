# hmp-beasts

`hmp-beasts` keeps the beasts a player catches. The game's beast bag (the Nab-Sack) belongs to the
connection and is empty on every join; this resource stores each `hmp-core` character's bag in MySQL,
puts it back into the player's game when that character loads, and empties the game's bag when the
player leaves the character, so beasts never follow a player onto another character.

A beast released from the Field Guide leaves the bag for good. With `release.respawn` on (the default) it
comes back into the world where the player stood, not catchable again unless `release.capturable` is on.

`/beasts` opens the player's beast list (an `hmp-ui` menu). Picking a beast offers **Free here**, which
asks first and then lets it go in front of the player, and **Rename**.

The Framework's server `Beast` builtin does the engine work: `Beast.bagOf`, `Beast.giveCaptured`,
`Beast.takeCaptured`, `Beast.create` and the `beastCaptured` / `beastReleased` events. A server build
without beast capture logs an error at startup and keeps nothing; the bag API below still reads and
writes the database.

## Configuration

Copy `examples/config/data/hmp-beasts.json` to `<server-root>/data/hmp-beasts.json`, or set
`HMP_BEASTS_CONFIG` to another path:

```json
{
  "command": "beasts",
  "enableCommands": true,
  "release": { "respawn": true, "capturable": false }
}
```

- `command`: the chat command that opens the beast menu, without the slash. `enableCommands: false` drops
  it; other resources can still open the menu through the `menu` export.

- `release.respawn`: bring a released beast back where its player stood. `false` makes a release a
  deletion, as in the game.
- `release.capturable`: whether that beast can be caught again straight away. Off, it is a world beast
  like any other server-spawned one until something makes it capturable.

The file is read at startup; restart the server after changing it.

## Storage

Migration 1 creates `hmp_beast_bags`, one row per character holding its bag as JSON. Rows go with the
character (`ON DELETE CASCADE`). Each stored beast has a `uid` that stays the same across connections;
the game's own bag entry ids change on every join.

When the resource starts while players are already playing, a character with no row yet keeps what its
game bag already holds; otherwise the stored bag replaces it.

A catch is written as soon as it happens. A beast stored without a colour is given one by the game the
next time it reaches a game bag, and that colour is kept from then on.

## API

```ts
const beasts = Imports.get("hmp-beasts");

const bag = await beasts.bag.list(player);              // the player's current character
const kept = await beasts.bag.list(characterId);        // any character, loaded or not
const given = await beasts.bag.give(player, { species: "Hippogriff", color: "Variation1", gender: "female", name: "Buckbeak" },
    { resource: "my-quests", reason: "quest reward" });
await beasts.bag.take(player, given.uid);
await beasts.bag.rename(player, uid, "Buckbeak");         // "" restores the species' own name
const freed = await beasts.bag.release(player, uid);     // { beast, respawnedBeastId } or null
await beasts.menu.open(player);                          // the /beasts menu, from your own key or zone
beasts.status();                                         // { state, lastError, loadedBags, uptimeMs }
```

- `give` validates the species and colour against `Beast.catalog()`. `color` and `gender` are optional:
  a missing colour is rolled by the game, a missing gender is chosen at random. `name` is at most 64
  bytes.
- While the character is loaded, `give`, `take` and `rename` change the player's game bag too; otherwise
  they change only the database, and the change arrives when the character next loads. The game's bag
  has no rename, so a rename swaps the entry, which moves it to the end of the Field Guide's list.
- `release` needs the player online with the character loaded: the beast goes free 3 m in front of them,
  facing them, under the same `release` settings as a Field Guide release.
- The calls reject with an error while the resource is starting or stopped, and when a player target has
  no character loaded.

## Events

```ts
Events.on("hmp:beasts:captured", ({ player, characterId, beast }) => { /* kept in the bag */ });
Events.on("hmp:beasts:released", ({ player, characterId, beast, at, respawnedBeastId, source }) => {
    // source: "fieldGuide" or "api" (bag.release, which the menu uses).
    // respawnedBeastId: the world beast it came back as, or null with respawn off or a failed respawn.
});
```

`HmpBeastCapturedEvent` and `HmpBeastReleasedEvent` in `types.d.ts` describe the payloads. A catch with no
character loaded is not kept and raises no event.

## Limits

- There are no staff commands; staff use the bag API from another resource or the server console.
