# hmp-characters

`hmp-characters` is the creation and selection experience for `hmp-core`. It presents a focused
character-card UI when a player's world and account session are both ready, opens Hogwarts Legacy's
native character creator, and persists the resulting appearance against the selected character.

The bundled renderer uses the same portrait-card presentation as HogwartsMP's original wardrobe
selector. Cards appear immediately, then their saved appearances are rendered locally and filled in
one at a time. Portraits are cached by appearance for the client session; a missing or failed capture
falls back to character initials instead of blocking selection.

## Responsibilities

- `hmp-core` owns character IDs, slots, account ownership and lifecycle.
- `hmp-characters` owns the selection UI and the `appearance`/`transmog` character metadata keys.
- `hmp-inventory` owns character-keyed inventory data; this resource asks it to restore the vanilla starting gear when a character is created.
- Future housing, progression and location resources own their own character-keyed data.

There is no second character database and no nickname-as-identity fallback.

## Join flow

1. The server waits for `hmp:session:ready`, client UI readiness and `worldReady`.
2. Existing characters are sent as small card records. A new account enters creation automatically.
   Appearance blobs follow as one bounded message per character so the selector never waits for every
   portrait before becoming usable.
3. Selection calls `hmp-core.characters.select` and remembers the last character on the account.
4. During `hmp:character:loading`, the stored appearance is applied and its native reload acknowledgement is awaited before transmog is restored and the core emits `loaded`.

After creator confirmation, the server records the current appearance revision and waits for a newer
`playerAppearanceChanged` publication. That publication is emitted only after the game's native
normalization has settled, so character cards receive the same complete look used by live players.

Portrait cards call the Framework-provided client `Portrait` API directly. They do not require or
load the mod repository's standalone `portrait` resource. The supported HogwartsMP client supplies
the off-screen avatar asset used by that API; unsupported clients degrade to initials.

Use `/characters` to reopen the selector after joining. Other resources can use the server exports:

```js
const Characters = Imports.get("hmp-characters");
await Characters.ui.open(player, { mode: "wardrobe" });

const choices = Characters.appearance.listTransmogs();
await Characters.appearance.setTransmog(player, choices[0]);
await Characters.appearance.clearTransmog(player);
```

The appearance API validates new transmogs against the Framework's built-in human-character allowlist,
applies them immediately, and persists them on the active character. Clearing restores the saved look.

## Switch policy

Before switching away from an active character, the resource emits `hmp:character:may-switch` with:

```js
{ player, from, to, allow: true, reason: "" }
```

A custody, combat or other policy resource may set `allow = false` and provide a player-facing
`reason`. Initial selection is not treated as a switch.

After a successful selection it emits `hmp:character:selected` with `{ session, character }`.

## Starting gear

The base game silently and unconditionally grants four cosmetic `_Basic` gear items during the first
main quest, `WEK_01` (Walking With Weasley). HogwartsMP enters through
`FreerideLoader::TryAutoLoad()` and never runs that mission, so a new multiplayer character would
otherwise be missing all four items. `startingGear` restores that vanilla grant; it is not a server
perk. The items are identified but left unworn by default, matching vanilla and avoiding stat or
balance changes.

The unworn default also keeps the character creator's glasses choice understandable. The creator's
“no glasses” option removes a forced appearance override; it does not hide the face slot. If real
glasses are equipped underneath, choosing “no glasses” therefore reveals those equipped glasses.
That is correct and matches vanilla, where the creator runs before the player owns items. The real
hide mechanism is `GA_Face_Hidden`, but it must not be attached to the creator's “none” choice: doing
so would remain as an override and hide face gear acquired later.

The grant is queued by `hmp:character:created` and applied after `hmp:character:loaded`, once the
correct character inventory has been restored. The native inventory catalog routes each item to its
declared holder (`CostumeStorage` for face gear), and the grant waits for native application so a
holder or item error is reported instead of looking like a silent success. After application, the
resulting native inventory snapshot is saved immediately so the gear survives reconnects and restarts.

## Configuration

Optional `data/hmp-characters.json`:

```json
{
  "autoOpenOnJoin": true,
  "allowDelete": true,
  "allowCloseWithActiveCharacter": true,
  "command": "characters",
  "appearanceTimeoutMs": 6000,
  "startingGear": [
    { "itemId": "Head_034_Basic", "identified": true, "equipped": false },
    { "itemId": "Neck_043_Basic", "identified": true, "equipped": false },
    { "itemId": "Hand_007_Basic", "identified": true, "equipped": false },
    { "itemId": "Face_005_Basic", "identified": true, "equipped": false }
  ],
  "title": "Choose Your Wizard",
  "subtitle": "Every story begins with a name."
}
```

Each `startingGear` entry is passed directly to a native inventory `give` patch, so servers may use
any catalog item ID and the supported native options (`count`, `variation`, `identified`, `equipped`,
and the other item flags). Set the array to `[]` to grant nothing. There is intentionally no separate
enable flag. When the key is absent, these four vanilla items remain the default.

Environment overrides are available through `HMP_CHARACTERS_CONFIG`,
`HMP_CHARACTERS_AUTO_OPEN`, `HMP_CHARACTERS_ALLOW_DELETE` and `HMP_CHARACTERS_COMMAND`.
