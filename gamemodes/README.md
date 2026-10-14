# HMP Gamemodes

Gamemodes are complete games built on HMP Foundations. They are optional: the core pack is the
infrastructure every Foundations server installs, and a server adds only the gamemodes it wants on top.

Each one lives in `resources/` here and has a row below.

| Gamemode | Description |
|---|---|
| [`hmp-gauntlet`](resources/hmp-gauntlet) | Cooperative wave survival: a party fights randomized, escalating waves of native enemies for ranked leaderboards. Built on activities, NPCs, interactions and worldstate. |
| [`hmp-quidditch`](resources/hmp-quidditch) | Quidditch on the Hogwarts pitch: called matches with house lineups, practice and Snitch hunts. Built on activities, houses, UI, input, inventory, audio, blips and world policy. |

## Versioning

Gamemodes release with the core pack and carry its version. Each release publishes them as a separate
archive, `hmp-gamemodes-v<version>.zip`, beside `hmp-foundations-v<version>.zip`. A gamemode only runs
against the core pack of the same version, and the archive's `gamemodes.json` names that version.

## Installing

1. Install the core pack first, as [INSTALL.md](../INSTALL.md) describes.
2. From `hmp-gamemodes-v<version>.zip`, copy the `hmp-*` directories you want out of `resources/` into
   `<server-root>/resources/`, next to the core resources, at the same top level.
3. Restart the server. Each gamemode loads after the core resources it depends on.

When upgrading Foundations, replace the gamemode directories from the same release as the core pack.
To remove a gamemode, stop the server and delete its directory; no core resource depends on one.

## Adding a gamemode

A gamemode lives in `gamemodes/resources/hmp-<name>`, as a workspace like any core resource, and uses
the pack's version. It may depend on any core resource; a core resource must never depend on a
gamemode. `npm run release:check` enforces both, along with the client-dependency and priority rules the
core pack follows, and expects the gamemode's `package.json` in the `Dockerfile`'s `npm ci` stage and
in `package-lock.json`. `npm run package` builds it into `build/hmp-gamemodes`.
