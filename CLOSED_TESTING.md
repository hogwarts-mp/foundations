# HMP Foundations closed testing

This pass should answer two questions: can players complete the normal Foundations flows without
staff intervention, and can staff understand and safely use the intervention tools when something
goes wrong?

## Staff setup

Set a unique `HMP_ADMIN_BOOTSTRAP_SECRET` of at least 16 bytes in the server environment and share it
only with designated testers. They open `/admin` and enter it in the masked prompt. This temporary
access ends on disconnect or resource restart. Do not enable asserted-identity bans.

Use test accounts and reversible changes wherever possible. Banking reconciliation is the exception:
it permanently resolves a pending transaction and should only be tested against a deliberately
created test transaction after its state has been inspected.

## Coverage

### Account, character, and spawn

- Connect for the first time, create a character, reconnect, and select it again.
- Confirm the saved character portrait matches the live character's face, hair, complexion, and other
  creator features before and after reconnecting.
- Create multiple characters, switch between them, and confirm inventory/location do not leak.
- Choose a configured spawn, reconnect, and use the character's last location.
- Travel between game areas and confirm a saved location from one area is not offered as a raw
  same-area teleport from another.
- Report any selector that opens too early, cannot be closed correctly, or leaves controls locked.

### World and environment

- Confirm the configured weather, time, date, season, and time scale apply on server startup.
- Fly into and over Hogsmeade with `removeBoundaryVolumes` enabled; native no-fly, height, speed, and
  dismount volumes must not constrain the broom, including after streaming into a new area.
- Temporarily preserve boundary volumes through the `hmp-world` API or server admin command, reload the
  area, and confirm the native restriction returns; reset the policy and confirm the JSON baseline wins.
- Confirm ambient students and native enemy encounters match the configured policy for every connected
  client and after world travel.
- Report environment changes that affect only one client, disappear on world travel, or survive a
  server restart despite differing from the JSON baseline.

### Houses and House Cup

- Assign each of the four houses in turn and confirm robes/crests rebuild to match without reconnecting.
- Run `/house`, switch characters, and confirm each character restores its own assignment. A character
  without an assignment must become Unaffiliated rather than inheriting the previous character's house.
- Confirm the effective `house:<name>` group changes with the assignment and that the previous house group
  is removed. Exercise one door, spell, or interaction rule through that projected group.
- Award points with an explicit reference, repeat the exact command, and confirm the standing changes only
  once. Reuse that reference with a different amount or house and confirm it is rejected.
- Dock points and confirm the configured negative-balance policy. Review `/points history` for the signed
  amount, resulting balance, source, and reference.
- If deliberately testing recovery, interrupt between creation and application only in a disposable
  database, inspect the pending row, then use `/points recover <reference>` once.
- Report house state crossing characters, stale projected groups, missing native robe/crest updates,
  duplicated point awards, silent failed deductions, or a transaction without a useful source/reference.

### Inventory

- Receive, stack, move, use, and remove custom items with icons.
- Confirm native potions and other supported game items appear without becoming duplicate custom
  items.
- Attempt a full-container move and confirm neither side changes after rejection.
- Report unclear item names, missing icons, incorrect counts, or changes that disappear on reconnect.

### Interaction and shops

- Approach and leave interaction prompts from several directions and distances.
- Travel between game areas and confirm old-area prompts disappear while loading and only the new
  area's prompts return.
- Open inventory or another focused dialog while standing at a prompt; pressing F must not trigger
  the interaction, and controls must return after the final screen closes.
- Exercise any two features configured on the same key and confirm only the eligible higher-priority
  shortcut fires. An equal-priority conflict should perform neither action and increment the input
  diagnostic conflict count.
- Attempt an interaction without its required group/item and confirm the server rejects it clearly.
- Buy and sell with Galleons; test insufficient funds, limited stock, and repeated submissions.
- Visit the example vendor from `data/hmp-shops.json` (Parry Pippin on the Hogsmeade high street): confirm he is dressed,
  facing the street, cannot be targeted or hurt by a spell, and reappears after walking 500 m away,
  reconnecting, and dying. Buy a Wiggenweld and confirm the stock count drops.
- Report stale prompts, double purchases, invisible stock changes, or payment/item mismatches.

### Doors

- Confirm the default policy leaves physical doors closed but allows them to be opened normally.
- Use `/doors list` near a known door and confirm its actor name appears in the client console.
- Add a temporary named deny rule, restart the resource, and confirm `/doors reload` applies it.
- Grant and revoke that door for one character; switch characters and confirm the grant does not leak.
- Test a group-gated exception, then add/remove the group and confirm access refreshes without reconnecting.
- Report a door that unlocks only after revisiting an area, a stale grant after revocation, or any scripted
  gate affected by a physical actor rule.

### Audio

- Run `/audio list menu`, then `/audio local click`; confirm only the caller hears the UI sound.
- Run `/audio play thunder 20000` with another player inside and outside 200 m; confirm delivery is
  range-scoped while volume still follows the event's authored attenuation.
- Start `accio` without a duration, stop the returned handle, and confirm its sustain ends cleanly.
- Start `accio` with a short duration and confirm it posts its authored release without another command.
- Reload a temporary gameplay resource while it owns a held sound and custom-bank lease; confirm the
  sound stops and the final lease unloads without stopping unrelated owners' sounds.
- Report silent first playback, a loop surviving owner/resource cleanup, an alias mismatch, or a bank
  unloaded while another owner still holds it.

### Blips

- Run `/blips marker 120` and confirm the private waypoint appears on the map, minimap, and compass.
- Run `/blips circle 80 120`, pulse it, then remove it; confirm the ring uses an 80-metre radius and
  neither marker survives removal or a resource restart.
- Travel to another game area while an area-scoped marker exists and confirm it disappears, then
  returns only when the audience and coordinate-space context match again.
- With `showAllPlayers: false`, register an on-duty job group and confirm presence is the union of
  matching groups, color goes to the highest priority, and same-area members disappear across travel.
- Connect after markers already exist and confirm replay includes only live, authorized markers.
- Report a stale marker after audience loss, a marker visible to an unauthorized group, a missing
  late-join marker, an invalid icon crash/refusal, or player colors surviving group/resource cleanup.

### Emotes

- Open `/emotemenu` as a normal player and confirm only named server aliases are visible.
- Play `/e popcorn`, stop it with `/e c`, and confirm another player sees both playback and release.
- Favorite an emote, reconnect, switch characters, and confirm the account preference remains.
- As a configured editor, confirm the full asset catalog appears and right-click a row to name it.
- Restart the server and confirm the live alias edit persists; clear it and confirm a configured alias
  remains hidden through its database tombstone.
- Preview and place a sitting pose, then cancel and stop it from every path; movement and controls must
  always return. Also test disconnecting during placement and reconnecting to the same pawn.
- Report invisible proxy animation, lingering props/sounds, stuck movement, stale alias permissions,
  duplicate shortcut responses, or an external renderer contract mismatch.

### Spells

- Run `/spells status` and confirm the example starter policy includes Lumos, Revelio, Accio, Levioso,
  and Incendio; the spell diamond must remain visible.
- Run `/spells loadout` after the world is ready and compare the four reported slots with the active
  in-game spell diamond.
- Assign spells through the normal spell menu, reconnect, and confirm all four diamonds are restored.
  Switch characters and confirm each character restores its own assignments without leaking slots.
- Grant one spell to a character, reconnect, and confirm it remains unlocked. Switch characters and
  confirm the personal grant does not leak.
- Revoke the grant and confirm Foundations policy changes immediately. Confirm the documented native
  limitation: the already-unlocked spell may remain usable until reconnect/travel, then must disappear.
- Set bonus loadouts from 0 through 3 and confirm exactly 1 through 4 total diamonds are available.
  Return loadouts to unmanaged ownership and confirm natural progression is no longer altered.
- Add/remove a group used by a spell rule and confirm its policy refreshes without restarting the server.
- Cast a spell and confirm an `hmp:spells:cast` observer receives an advisory event; never attach money,
  damage, quest completion, or punitive action to this client-reported signal.
- Report a missing policy after travel, bulk unlock banners, a spell HUD that disappears despite Lumos,
  grants crossing characters, incorrect loadout counts, or a cast event presented as authoritative.

### Progression and talents

- Run `/progression status` on a new character, add XP as staff, and confirm the reported native level
  and applied/current revisions converge after the world is ready.
- Repeat one reward through a small test gameplay resource with the same explicit reference and confirm
  XP changes once. Reuse that reference with a different amount and confirm Foundations rejects it.
- Set a lower and higher level target and confirm XP, the native level bar, and talent points reconcile
  without multiplying talent points after reconnect or area travel.
- Grant a talent, reconnect, and confirm it returns. Revoke it, reconnect again, and confirm the
  revocation tombstone prevents the save from restoring it.
- Give one talent point and buy a talent whose native prerequisites are met. Confirm exactly one point is
  spent and the entitlement persists. Attempt an unavailable talent and confirm neither the point nor
  the durable ledger changes.
- Switch characters and confirm XP, level, talent points, and managed talents do not leak. Local XP
  earned outside a server reward must not silently become durable Foundations XP.
- Report duplicate XP, revision counters that never converge, talent points multiplying on travel,
  failed revocations, purchases recorded after native refusal, or any progression state crossing characters.

### Banking and jobs

- Deposit and withdraw native Galleons, transfer between accounts, and reconnect.
- Join a job, change active employment, go on/off duty, and verify grade permissions.
- Run a payroll case and confirm the employer and employee balances both change once.
- Report unclear account ownership, unexpected permission inheritance, or any pending transaction.

### Activities and LFG substrate

- Keep the example configuration's `enableTestActivity` enabled for this pass. Have one player run
  `/activities create foundations:test-party healer` and another use `/activities list`, join the
  displayed short ID as `caster`, and ready up.
- Confirm the lobby is not startable until the healer/caster minimums, total-player minimum, and every
  ready flag are satisfied. Confirm a second healer is rejected because that role is full.
- Have the non-leader attempt to start or cancel the group and confirm it is rejected. Then have the
  leader start it successfully.
- Create another forming group, disconnect its leader, and confirm leadership transfers. Disconnect
  the last member and confirm the empty lobby disappears.
- Attempt discovery and joining from a different game area or virtual world. The area-scoped test
  group must not appear and a direct join must be rejected.
- Report duplicate membership, overfilled roles, a stale expired lobby, incorrect leader transfer,
  cross-area discovery, or any running group surviving a participant disconnect without cancellation.

### PvP policy and duels

- Keep `hmp-pvp.defaultDecision` set to `deny`. Outside an agreed duel, cast at another player and
  confirm the server vetoes the hit.
- Challenge with `/duel <playerId>`. Confirm the target receives the Arcanum-default consent dialog,
  can decline it, and that the challenge expires without leaving either player busy.
- While one challenge is pending, attempt another outgoing challenge and confirm exclusivity rejects
  it. Attempt a cross-area challenge and confirm it is rejected.
- Accept a challenge and confirm neither player can damage the other during the authoritative
  countdown. After “Duel!”, verify mutual lock-on/homing, opponent health meters, and normal spell hits.
- Deal a finishing burst and confirm the loser remains at or above the configured health floor,
  enters the retail kneel when available, and both clients restore targeting, team, meter, recovery,
  and damage-immunity state afterward.
- As configured staff, run `/pvp lethal on`. Confirm all connected players can mutually lock on and
  ordinary relayed damage can enter the real death/respawn flow; a player joining afterward must inherit
  mutual targeting after the configured delay.
- While lethal mode remains on, complete another duel and confirm its finishing hit is still floored and
  kneel-finished. After the duel, both participants must return to open-world mutual hostility rather than
  becoming untargetable. Run `/pvp lethal on` again and `/pvp sync` to exercise proxy re-fan recovery.
- Run `/pvp lethal off` and confirm third-party hits are denied and the global hostile presentation clears.
  Do not report the currently documented missing victim-side green-bolt cosmetic as an arbitration failure.
- Exercise `/duel forfeit`, death, and disconnect. Confirm each closes the activity exactly once and
  the remaining player can immediately issue or accept another challenge.
- Report any damage before consent/countdown, hits against third parties, a lethal duel result,
  duplicate outcome, stale hostile relationship, missing cleanup, a lethal hit inside a duel, or a mode
  transition that leaves the wrong players targetable.

### Administration

- Open each form containing a dropdown, confirm every option is visibly rendered above the dialog,
  and verify both mouse and arrow-key selection return the chosen value.
- Locate the intended player using nickname, ID, account, character, and identity-trust details.
- Warn, freeze/release, go to, bring, and kick a consenting test player.
- Confirm go-to and bring reject players in different game areas rather than applying foreign-map
  coordinates.
- Correct a custom item, group, job grade, and small Galleon balance, then verify the result.
- Review the audit after both a successful action and an intentionally rejected action.
- Confirm an asserted-identity player cannot receive a durable ban. Test a timed ban only with a
  disposable verified identity once the real provider is available.
- Report actions whose result or risk was unclear, missing recovery steps, and menu state that became
  stale after disconnects.

## Issue report

Include:

1. Resource and feature.
2. Exact player/staff actions in order.
3. Expected and observed result.
4. Whether reconnecting or restarting changed the result.
5. Player IDs, character/account IDs, approximate time, and relevant admin audit ID.
6. Screenshot or short video for UI issues; server log excerpt for errors.
7. Severity: blocker, data/currency risk, gameplay failure, confusing behavior, or cosmetic.

Never include the bootstrap secret, database credentials, IP addresses, or identity tokens in a
report.
