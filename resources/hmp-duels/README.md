# hmp-duels

`hmp-duels` is Foundations's consensual, non-lethal one-on-one wizard duel resource. A challenge is a
private `hmp-activities` invitation; accepting creates an exclusive two-player session scoped to the
same game area and virtual world. Its `hmp-pvp` rule governs only that agreed pair, leaving other PvP
resources to own their own matches or zones.

An accepted duel is a host pair override (`Pvp.setPair`): peaceful through the countdown, then hostile
with lock-on and a kneel finish, whatever the server's own PvP rules say. The host decides who may hurt
whom for both clients, and natural health recovery is held off for the fight. When the duel ends the
override is cleared and the two return to the server's own rules.

The duel rule has higher priority than `hmp-pvp`'s open-world lethal fallback, so participants remain
floored and kneel-finished even while staff have lethal mode on for everyone else. Each hit is floored at
`koHp` on the victim's live health. The victim's own client kneels on the finishing hit and the host
reports it as `pvpDefeat`, which ends the duel; nothing trusts the server's possibly stale vitals report.
The client only presents the countdown, the opponent's health meter and the result.

The loser's kneel lasts as long as the server's PvP rules say (`kneelSeconds`, 4 s by default) and ends
by itself. On a server whose rules hold kneels (`kneelSeconds: 0`, down until `player.endKneel`), the duel
stands its loser up 4 s after the knock-out, or at once if `hmp-duels` stops first. This needs a
HogwartsMP host with `kneelSeconds` and `player.endKneel`; an older host's kneel always ends by itself.

Commands (a player id takes a `#`, as in `/duel #5`):

```text
/duel <#playerId|exact nickname>
/duel accept
/duel decline
/duel cancel
/duel forfeit
/duel status
```

Challenge consent uses `hmp-ui`, whose bundled Arcanum renderer remains the default and whose external
renderer contract lets server owners replace the presentation. Input focus and control ownership are
therefore handled by `hmp-ui`/`hmp-lib`, not by duel-specific browser code.

The activity session owns exclusivity, invitation expiry, location compatibility, and disconnect
cleanup. This prevents one challenger from reserving several opponents or an old acceptance from
overwriting a newer duel pair.
