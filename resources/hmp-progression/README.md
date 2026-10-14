# hmp-progression

`hmp-progression` owns character-scoped experience, the last game-confirmed level, talent points,
Foundations-managed talents, and a replay-safe reward ledger. MySQL is authoritative; the client
reconciler applies an absolute snapshot through Hogwarts Legacy's native progression and talent APIs.

The resource does not accept unsolicited client XP. A modified client can still alter its local
single-player simulation, but it cannot award itself durable Foundations XP or invent a managed talent.
Native level and talent-point reports are accepted only for the exact character, revision, and XP
snapshot the server issued. Server gameplay should use this resource's profile for gates.

### Known limitation: kill experience does not persist

The host pays NPC kill rewards on the killer's client (the NPC `rewardPolicy`: the game's own kill reward
and any flat `experience`). The server is not told the amount, so nothing reaches this resource's ledger:
the experience appears in game, and the next synchronization (reconnect, character switch, or any
progression change) sets it back to the stored total. Field Guide knowledge and kill-challenge progress
from the same kills are unaffected. Award durable kill experience from a server resource with
`progression.add` on `npcDied` until the host reports kill rewards to scripts.

## Exports

`Imports.get("hmp-progression")` exposes:

- `progression.get(target)` — get or initialize a character profile.
- `progression.add(target, signedPoints, options)` — atomically adjust XP.
- `progression.set(target, points, options)` — atomically set absolute XP.
- `progression.setLevel(onlinePlayer, level, options)` — resolve that save's native level boundary and
  set XP to it.
- `progression.transaction(reference)`, `history`, `pending`, and `recover` — inspect/recover rewards.
- `progression.sync(player)` — resend the complete native snapshot.
- `talents.list(target, includeRevoked?)` — list Foundations-managed talent state.
- `talents.grant`, `purchase`, `revoke`, and `reset` — manage durable talent entitlements.
- `talents.setPoints(target, points, options)` — set the canonical unspent point pool.
- `status()` — readiness and reconciliation diagnostics.

Every XP mutation requires a stable `reference` and `resource`. Repeating the same operation with the
same reference returns its original transaction; reusing it for different input is rejected.

```ts
const { progression } = Imports.get("hmp-progression");

await progression.add(player, 250, {
    reference: `dungeon:${runId}:character:${characterId}`,
    resource: "rp-dungeons",
    reason: "completed dungeon",
    metadata: { dungeonId },
});
```

`talents.purchase` asks the player's native tree to validate the talent's prerequisites, then records
the entitlement and spends exactly one Foundations talent point. `talents.grant` is the administrative
path: it deliberately ignores native purchase gates and costs no point. Revocations are retained as
tombstones so a talent cannot return from the local save on reconnect.

## Events

- `hmp:progression:changed` after a canonical XP or talent-point mutation.
- `hmp:progression:synchronized` after the game acknowledges the current absolute snapshot.
- `hmp:progression:talentChanged` after a managed grant, purchase, or revocation.
- `hmp:progression:talentsReset` after managed talents are reset.

## Closed-test command

`/progression status|talents|buy|add|set|level|grant|revoke|points|reset`

Status, managed talents, and buying for oneself are player-accessible. All other mutations require a
configured admin group. Disable the command after testing and use resource exports from gameplay and
administration resources in production.
