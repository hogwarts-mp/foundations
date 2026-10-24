# Example Foundations configuration

Copy the contents of `data` to `<server-root>/data`, where `<server-root>` is the working directory
used to launch `HogwartsMPServer.exe` on Windows or `HogwartsMPServer` on Linux. Edit the copies;
these are safe starting values, not production secrets. See the top-level `INSTALL.md` and
`DATABASE.md` for the complete setup procedure.

Configuration files are provided for resources with file-backed settings. `hmp-lib`, `hmp-ui`,
`hmp-banking`, and `hmp-jobs` use built-in defaults and registration APIs; server-specific banks,
jobs, and interactions belong in a separate gameplay resource.
`hmp-interact` includes only its opt-in `/interact outlines` closed-test command, which rings the
interaction zones around the caller on their own screen; interactions themselves register from code.
`hmp-shops` includes a data-declared shop list (an example potion vendor with a stationary character
body and limited stock); shops needing handlers or predicates still register from a gameplay resource.
`hmp-business` includes price bounds, the house-cut policy, the `/business` admin groups, and a
data-declared Pippin's business that comes alive once a gameplay resource registers the `pippins` job.
`hmp-doors` includes a file-backed example because physical-door access is a server-wide world policy;
`shareUnlocks` stays off, so a door one player picks stays locked for everyone the rules keep out. It
holds no gates (`heldGates`) and leaves portcullises on each client's clock (`gateSchedule: "local"`).
`hmp-world` includes the baseline weather, clock, date, season, mount-boundary, ambient-population,
native-encounter, player-collision, fast-travel, travel-health, and jump/sprint policy applied to every
client.
`hmp-express` includes the game's own Hogwarts Express timetable with a two-minute stop at Hogsmeade station.
`hmp-worldstate` includes the `/worldstate` admin groups and the repairable-object report limit.
`hmp-loot` includes two example lootables in a Hogwarts courtyard and switches the game's own chests,
moonstones and foragables off.
`hmp-beasts` includes the `/beasts` menu command and the release policy: released beasts come back into the
world, not catchable again.
`hmp-npcs` includes total and per-resource limits for NPCs managed through the Foundation service.
`hmp-emotes` includes one for curated aliases, editor groups, the `allowAll` catalog policy, and renderer selection.
`hmp-audio` includes one for Wwise aliases, positional range, handle limits, and closed-test commands.
`hmp-blips` includes one for marker lifetimes, player visibility, native tint/scale, and private probes.
`hmp-spells` includes a closed-testing starter kit, group rules, admin commands, cast-report limits, and
one server-defined spell, Firestorm, which stays locked until granted (`/spells grant me Firestorm`) and
needs a HogwartsMP host with `Spells.define`; an older host skips it with a warning. Its lesson,
`FirestormLesson`, grants it once completed (`/spells teach me FirestormLesson`) and needs a host with
`SpellLearning.define`; on an older host it fails as unsupported and grants nothing.
`hmp-progression` includes XP/talent bounds, reconciliation timeouts, and closed-test admin permissions.
`hmp-houses` includes group projection, point-balance policy, and closed-testing command permissions.
`hmp-activities` includes bounded lobby settings and an opt-in dungeon-party-shaped test definition.
`hmp-pvp` includes the server-wide default decision, lethal-mode default, staff groups, and join-sync delay;
keep the fallback `deny` and lethal mode off unless the server intentionally runs open-world mortal PvP.
`hmp-duels` includes challenge expiry, countdown, command, non-lethal health-floor, and cosmetic-gear settings.
`hmp-webhooks` includes named destinations plus gauntlet, activity, and advisory spell-cast routes. Its
Discord URL is intentionally supplied through the server environment rather than the JSON example.

The MySQL JSON intentionally contains `CHANGE_ME`. Prefer injecting `HMP_MYSQL_URL` or the individual
database environment variables instead of keeping a production password in the file. Likewise,
`HMP_ADMIN_BOOTSTRAP_SECRET` exists only in the process environment and must contain at least 16 bytes.
Webhook endpoint secrets should likewise be injected through the destination's configured `urlEnv`.
Foundations does not automatically read `environment.example` or a `.env` file.

Review at minimum:

- the database host, user, password, database, TLS policy, and connection limits;
- every spawn coordinate against the supported game build, and whether players should load and respawn
  at an `hmp-spawn` spawn point (`worldSpawn`, `respawnAtSpawn`);
- whether deleting characters is appropriate for the test;
- custom item names, weights, stack sizes, and resource-hosted icon URLs;
- the inventory UI URL if the server replaces the bundled Arcanum renderer;
- the physical-door default, group exceptions, and whether closed-test door commands remain enabled;
- the starting environment and whether native mount boundaries, ambient population, and encounters are enabled;
- the Hogwarts Express timetable and stops, or `enabled: false` when another script runs the train;
- which emotes players may browse, which groups may curate aliases, and the emote UI URL;
- audio aliases, positional delivery range, handle limits, and whether `/audio` testing is enabled;
- marker TTL/limits, whether every remote player is shown, and the player-blip tint/scale settings;
- starter spell policy, group-gated kits, bonus loadouts, and whether `/spells` testing is enabled;
- maximum XP/talent-point bounds and who may use progression administration commands;
- the house group prefix, whether standings may go negative, and who may assign houses or points;
- activity lobby limits and expiry, and whether the non-gameplay closed-test definition remains enabled;
- whether the `/interact outlines` zone overlay remains available;
- the global PvP fallback decision, lethal-mode default/staff groups, duel countdown/expiry, and the
  non-lethal health floor;
- the admin role-to-capability rules and verified-identity policy.
- whether outbound webhooks are enabled, which event routes are appropriate, and which environment
  variables hold each destination URL.
