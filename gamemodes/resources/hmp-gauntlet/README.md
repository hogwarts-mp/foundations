# hmp-gauntlet

`hmp-gauntlet` is a cooperative wave-survival gamemode. Players form a Foundations activity, then
fight randomized, escalating waves of real Hogwarts Legacy enemies. The gamemode owns encounter
rules, scoring, leaderboards, its configuration screen, and its HUD. Foundations owns the reusable
session, character, input, NPC, and interaction behavior.

## Flow

1. The host opens the configuration screen with `/gauntlet menu` or the optional altar.
2. Starting creates a public `hmp-gauntlet:survival` activity lobby at the host's position.
3. Other players use `/gauntlet join`.
4. The host uses `/gauntlet begin` to lock membership and start the waves.
5. Clearing the configured waves completes the activity. A party wipe completes it as a loss, and
   `/gauntlet stop` cancels it.

## Commands

```text
/gauntlet menu
/gauntlet start
/gauntlet join
/gauntlet begin
/gauntlet stop
/gauntlet status
/gauntlet top [preset]
```

`start` creates a lobby with the default preset without opening the configuration screen. `top` is
public; the remaining commands operate on the current activity.

## Foundations integration

- `hmp-activities` owns lobby membership and lifecycle transitions.
- `hmp-interact` owns the optional altar, prompt, range check, and world object.
- `hmp-lib` owns command routing, configuration loading, logging, and the client control lease.
- `hmp-core` owns active-character leaderboard metadata.
- `hmp-worldstate` persists the server-wide leaderboards.
- `hmp-npcs` supplies the Framework-verified enemy catalog and owns resource-scoped NPC spawning and cleanup.
- `hmp-gauntlet` bundles its configuration screen and HUD, so it has no `hmp-ui` dependency.

It types against each core resource's own `types.d.ts`, so a Foundations API change fails its
typecheck instead of the running server.

## Configuration

The defaults live in `server/config.ts`. A server can override them with `data/hmp-gauntlet.json`, or
the file `HMP_GAUNTLET_CONFIG` names; overrides are normalized before use. Supported sections are
`presets`, `defaultPreset`, `bosses`, `hidden`, `groups`, `arena`, `players`, and `interaction`.

The enemy roster comes from the runtime `hmp-npcs` catalog, which is verified against the Framework's
native definitions. Bosses missing from the catalog are skipped. The altar is off by default; enable
`interaction.enabled` and author its `position`, `areaId`, and optional `regionId` for your map:

```json
{
  "interaction": {
    "enabled": true,
    "position": { "x": 0, "y": 0, "z": 0 },
    "areaId": "Overland",
    "label": "Enter the Gauntlet"
  }
}
```

## Scaling and persistence

Each wave scales enemy count, health, size, and boss cadence. Enemy ownership is round-robined across
connected activity participants so the pack distributes aggro. Ownership stays fixed for an enemy's
lifetime because reassignment re-embodies and heals the pawn.

Ranked runs require an unchanged preset and the full enemy roster. Scores are separated by preset and
party-size bucket. Server records live in the `gauntlet-board` system of `hmp-worldstate` (MySQL,
server-only); per-character bests use `hmp-core` metadata under `hmp-gauntlet:bests`.

## Events

Every run that ends raises the server event `hmp-gauntlet:complete` once, with an
`HmpGauntletCompletion` payload (see `types.d.ts`): the result, wave, score, preset, bucket, whether
it was ranked, and the participants still connected.

## Development

From the repository root:

```text
npm run typecheck -w hmp-gauntlet
npm test -w hmp-gauntlet
npm run build -w hmp-gauntlet
npm run smoke -w hmp-gauntlet
```

`server/main.ts`, `server/config.ts`, and `client/main.ts` are the authored sources; the build bundles
them into `dist/server.js` and `dist/client.js` and copies the two static pages beside them.

Current gameplay limitations are one global run at a time, fixed enemy ownership, owner-only enemy
damage, and client-local HUD and configuration rendering.
