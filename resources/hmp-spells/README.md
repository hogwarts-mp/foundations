# hmp-spells

`hmp-spells` is Foundations's character-scoped spell entitlement and loadout layer. Server rules decide
which native Hogwarts Legacy spell locks remain unlocked; direct grants, managed bonus loadouts, and
spell-diamond assignments persist on the active `hmp-core` character.

The resource does not reimplement casting. Its client forwards complete policies to the mod's native
`Spells.setPolicy` enforcer, which survives streamed level changes and suppresses bulk unlock banners.

## Rules

Rules use the same lower-number-is-stronger policy model as `hmp-doors`. A deny wins an equal-priority
tie. No matching allow means the spell remains locked.

```json
{
  "id": "auror-kit",
  "resource": "hmp-ministry",
  "priority": 500,
  "action": "allow",
  "spells": ["Stupefy", "Expelliarmus", "Protego"],
  "bonusLoadouts": 2,
  "match": {
    "groups": [{ "key": "job:auror", "minimumGrade": 2 }]
  }
}
```

`spells` accepts friendly catalog names, raw `Spell_*` lock IDs, or `"*"`. `bonusLoadouts` is valid on
allow rules and grants 0-3 additional spell diamonds. Each active character uses its personal override,
otherwise the applicable rule count, otherwise zero bonus diamonds (one total loadout).

Other resources can register owner-scoped rules at runtime:

```ts
const Spells = Imports.get("hmp-spells");
const unregister = Spells.rules.register({
    id: "dueling-club",
    resource: "hmp-dueling",
    priority: 700,
    action: "allow",
    spells: ["Levioso", "Accio", "Expelliarmus"],
    match: { groups: [{ key: "club:dueling" }] },
});
```

Runtime rules are removed when their owning resource stops. Call the returned function to unregister one
earlier.

## Character grants and loadouts

```ts
await Spells.grants.grant(player, "Incendio", {
    resource: "hmp-quests",
    actor: player,
    reason: "Completed the Incendio lesson",
});

await Spells.grants.revoke(player, "Incendio", { resource: "hmp-admin" });
await Spells.loadouts.set(player, 2, { resource: "hmp-progression" });
await Spells.loadouts.unmanage(player, { resource: "hmp-progression" });
```

Spell grants and loadout ownership are stored together under the active character's
`hmp-spells:entitlements` metadata key. The four spell diamonds are stored under
`hmp-spells:loadout-assignments` using the version-2 provider-reference schema. Foundations is the
authority for those slots and restores registered gameplay names into QuickActionManager when a
character loads. Live slots are imported on assignment events, not by a polling timer.
None of this state leaks between character slots.

Native-menu and client API `spellAssignment` events import changed live slots and save them for
that character. The server acknowledges these saves without replaying the loadout policy: those
slots are already assigned, and replaying them inside the open menu can cause extra assignment
sounds and invalid menu icons. Server API changes and character/world restoration still sync
the policy to apply the authoritative slots.

Diamond assignments use stable `provider:spell` references. Native compatibility entries use
`native:Lumos`; a mod can register `my-spells:shield`, for example. Version-1 native names and raw
plugin record paths migrate to `native:*` and `record:*` compatibility references when read.

```ts
const dispose = Spells.providers.register({
    id: "my-spells",
    resource: "my-spells",
    label: "My custom spells",
    spells: [{
        id: "shield",
        label: "Shield",
        kind: "native",
        nativeName: "MyMod_Shield", // The gameplay name registered by the spell mod.
    }],
});

await Spells.loadouts.setSlot(player, 0, 0, "my-spells:shield", {
    resource: "my-spells",
    reason: "equipped by the player",
});
```

`kind: "native"` names the game's slot/cast route, not a restriction to vanilla spells. Creator Kit
spells registered with that system use their gameplay names and the native HUD/input like other spells;
there is no assignable-spell whitelist in Foundations.

For explicit script-driven casting, `kind: "record"` with a plugin-rooted `recordPath` remains available
through the client `cast(slot)` API. It calls `Spells.castRecord` only when requested by a script.
Record-only references do not identify a native slot: they remain saved, but their native cells are
cleared to prevent stale spells from another character. Use a registered gameplay name for native
HUD/input support. Foundations installs neither a custom HUD nor spell-casting key bindings.

Provider registrations are owner-scoped and disappear when their resource stops; saved refs remain
intact and become available again when the provider returns. The reserved `record:` adapter remains
available for migration/testing, but named providers are the intended API.

A native unlock sticks for the rest of the session, so a revoke cannot work by dropping the lock from
the policy. The resolved policy is authoritative over the whole spell lock table: every catalog spell
the rules don't allow is listed in `lockSpells` and re-locked by the client, immediately and on every
later sync. `action: "deny"` therefore takes a spell already in hand, which is what a timed
`rules.register(...)` deny (a duel, a wandless minigame) needs; dispose the rule to hand it back.
Nothing is exempt, so a `freeride-baseline` allow rule for `Spell_Protego`, `Spell_Stupefy` (the
game's fresh-character defaults) and `Spell_AimMode` (opened by the client's freeride boot) is always
present — `data/hmp-spells.json` replaces the rule array wholesale, and omitting the baseline there
would silently take right-click aiming and the basic spell away. Denying any of them is still a
supported choice: a `deny` rule at priority 900 or stronger outranks the baseline, and a rule of your
own with `"id": "freeride-baseline"` replaces it outright.

Bonus-loadout changes apply immediately. Each active character uses
its explicit count override, otherwise the applicable rule count, otherwise zero bonus diamonds (one
total loadout). `unmanage` clears the character override and restores the rule/default count; this can
remove extra native loadout perks. Count changes do not erase saved slot assignments or spell grants.

## Catalog and policy APIs

- `catalog.resolve/get/list` normalize names and raw lock IDs.
- `policy.resolve/sync/syncAll` inspect or push complete policies. `sync` returns `null` and `syncAll`
  skips a player with no `hmp-core` session yet; `hmp:session:ready` syncs them moments later.
- `rules.register/unregister/clear/list/refresh` manage runtime rules.
- `providers.register/unregister/clear/get/list/resolve` manage cast adapters and spell definitions.
- `grants.list/grant/revoke/clear` manage persistent character grants.
- `loadouts.get/set/unmanage` manage the 0-3 bonus diamonds.
- `loadouts.getAssignments/setAssignments/setSlot` inspect or change character-scoped slots.
- `status()` reports catalog, rule, synchronization, and lifecycle state.

The client resource exposes `loadout`, `setLoadoutSlot`, and explicit `cast` against Foundations state.
Native slots continue through the game's normal input path, including the player's key bindings.
`importNativeAssignments()` handles stock-menu and direct native-API changes; login restores stored
assignments instead of capturing the previous character's native diamond.
A successful slot change from either the public API or the stock spell menu emits the client
`spellAssignment` event. Its `source` is `api` or `native-menu`; login restoration is suppressed.

## Advisory spell-cast event

Native local casts are forwarded to the server and re-emitted as `hmp:spells:cast`. The payload includes
the player, active character, native asset path, friendly name, resolved lock ID, current entitlement
verdict, and `advisory: true`.

This event is client-reported and therefore forgeable. It is rate-limited for operational safety, but it
must not authorize damage, currency, quest rewards, anti-cheat action, or other consequential state.

## Closed-testing command

Safe inspection is public:

```text
/spells status
/spells list [search]
/spells loadout
```

Members of a configured `adminGroups` entry may use:

```text
/spells grant <me|nick|#id> <SpellName>
/spells revoke <me|nick|#id> <SpellName>
/spells grants <me|nick|#id>
/spells clear <me|nick|#id>
/spells loadouts <me|nick|#id> <0-3>
/spells unmanage-loadouts <me|nick|#id>
/spells reload
```

Set `enableCommands` to false outside testing when scripts provide the management surface.
