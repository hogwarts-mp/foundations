# hmp-pvp

`hmp-pvp` is the one Foundations resource that installs the native server `Pvp.setPolicy` callback.
Gameplay resources register owner-scoped rules instead of replacing one another's global callback.

Rules evaluate from highest priority to lowest. `undefined` abstains; the first boolean, number, or
decision object is final. A throwing rule fails closed for that hit. The default is also deny, so
installing Foundations never silently changes a consent-only server into open PvP.

`hmp-pvp` also owns the server-wide lethality mode. With it off, an otherwise undecided hit is denied.
With it on, an otherwise undecided hit proceeds through native full arbitration, so lethal spell damage
can reach zero health and enter the real death/respawn flow. Higher-priority rules still win; this is why
an active `hmp-duels` pair remains non-lethal even while the rest of the server is lethal.

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

Who may hurt whom is the host's: its PvP rules and pair overrides decide it for every client, late joiners
included, and a hit between players who are not hostile is dropped before any policy runs. Lethal mode is
the host rules' `who: "everyone"`; turning it off sets `who: "none"`, unless something else has already
narrowed `who`. `hmp-pvp` follows `pvpRulesChanged`, so a staff tool or resource that changes `who` directly
keeps the mode in step, and stopping `hmp-pvp` while lethal ends lethal mode.

A resource that makes players hostile itself (a pair, a team or `who`) must also register a rule that allows
their hits: with `defaultDecision: "deny"` and lethal mode off, an undecided hit is still vetoed here.

Unforgivable replay suppression remains a native safety boundary. Lethal player kills must use the relayed,
server-arbitrated hit path. The current host also does not replay the victim-side green-bolt cosmetic for a
relayed Killing Curse; that visual limitation does not change the authoritative lethal result.
