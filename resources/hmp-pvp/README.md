# hmp-pvp

`hmp-pvp` is the one Foundations resource that installs the native server `Pvp.setPolicy` callback.
Gameplay resources register owner-scoped rules instead of replacing one another's global callback.

Rules evaluate from highest priority to lowest. `undefined` abstains; the first boolean, number, or
decision object is final. A throwing rule fails closed for that hit.

Rules only ever see hits the host already allowed: its PvP rules and pair overrides decide who is hostile,
and a hit between players who are not is dropped before any policy runs. An undecided hit therefore follows
`defaultDecision`, `"allow"` by default, so the host's own relations stand: the host's default `who: "none"`
keeps a fresh server consent-only, and a team, flag or pair another resource sets up deals damage. Set
`"deny"` to make rules registered here the only way a hit lands.

`hmp-pvp` also owns the server-wide lethality mode. With it on, everyone is hostile and an undecided hit
proceeds even under `"deny"`, so lethal spell damage can reach zero health and enter the real death/respawn
flow. Higher-priority rules still win; this is why an active `hmp-duels` pair remains non-lethal even while
the rest of the server is lethal.

```ts
const PvpPolicy = Imports.get("hmp-pvp");
const dispose = PvpPolicy.policy.register({
    id: "arena",
    resource: "my-arena",
    priority: 500,
    decide(hit) {
        if (!arenaPairs.has(`${hit.casterId}:${hit.victimId}`)) return undefined;
        return { minHp: 1 };
    },
});

PvpPolicy.mode.setLethal(true, {
    resource: "my-rp-mode",
    reason: "faction war started",
});
```

Resource-stop cleanup removes every rule owned by that resource. `vitals(playerId)` exposes the
native last-reported health view for diagnostics; it remains advisory and potentially stale. Use the
victim-enforced `minHp` decision for non-lethal guarantees.

Staff in a configured group may use `/pvp status`, `/pvp lethal on` and `/pvp lethal off`.
The compatibility bus event `pvp:lethalMode` accepts a boolean for existing server resources; new resources
should prefer `mode.setLethal()`. Changes emit `hmp:pvp:lethal-mode-changed` for observers.

The host resolves relations for every client, late joiners included. Lethal mode is the host rules'
`who: "everyone"`; turning it off sets `who: "none"`, unless something else has already narrowed `who`.
`hmp-pvp` follows `pvpRulesChanged`, so a staff tool or resource that changes `who` directly keeps the mode
in step, and stopping `hmp-pvp` while lethal ends lethal mode.

Unforgivable replay suppression remains a native safety boundary. Lethal player kills must use the relayed,
server-arbitrated hit path. The current host also does not replay the victim-side green-bolt cosmetic for a
relayed Killing Curse; that visual limitation does not change the authoritative lethal result.
