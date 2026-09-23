# hmp-lib

Shared, dependency-free utilities for HogwartsMP resources. It consolidates the player lookup,
command routing, input validation, rate limiting, configuration, localization, logging, text,
number and position helpers that otherwise get reimplemented by every resource. On the client it
also owns Foundations control leases and arbitrates shortcuts so two eligible resources cannot both
react to one physical key edge.

`hmp-lib` deliberately contains no roles, characters, inventory policy or UI. Those belong to
`hmp-core`, `hmp-inventory` and `hmp-ui`. The resource also does not replace the Framework's native
`Events`, `Messages`, `Storage`, `Exports` or `Imports` APIs.

## Distribution

Foundations releases include built server and client bundles. Server owners do not install npm
packages. The shared helpers are available on both sides; `config`, `player` and `command` are
server-only.

## Import

Declare the dependency:

```json
"resourceDependencies": [{ "name": "hmp-lib", "version": "0.5.0" }]
```

Then import its exports:

```js
/** @type {import("../../hmp-lib/types").HmpLibServer<Player>} */
const Hmp = Imports.get("hmp-lib");

const target = Hmp.player.find("#7", player);
const label = Hmp.text.clean(input, 80);
if (Hmp.position.within(player, target, 300)) { /* within three metres */ }
```

Client resources import the same way, using `HmpLibClient` as the type.

## Input and control ownership

Client screens acquire a named control lease instead of calling `Game.lockControls` themselves:

```ts
const Hmp = Imports.get("hmp-lib");
const lease = Hmp.input.controls.acquire({ resource: "hmp-robes", id: "wardrobe" });

// Closing normally; stopping hmp-robes also releases it automatically.
lease.release();
```

`hmp-lib` holds only one Framework control lock regardless of how many Foundations screens are open.
It releases that lock when the final owner closes. A `resourceStop` removes every lease owned by that
resource, preventing a crashed or hot-reloaded screen from stranding the cursor and controls. Owners
are unique `resource + id` pairs; acquiring the same owner twice throws instead of hiding an
unbalanced open/close path.

Shortcuts use the same ownership model:

```ts
const unregister = Hmp.input.shortcuts.register({
    resource: "hmp-robes",
    id: "open-wardrobe",
    key: "r",
    state: "down",
    priority: 10,
    when: () => canOpenWardrobe(),
    handler: () => Events.emitServer("hmp-robes:open", "{}"),
});
```

For a physical key edge, the highest-priority eligible shortcut owns it. If two eligible shortcuts
share the highest priority, neither fires; the conflict is counted and logged once rather than
running two gameplay actions. `setEnabled` temporarily disables a registration, `rebind` changes its
physical key, and the disposer or `resourceStop` removes it. The Framework continues to suppress the
single underlying key handler while chat/CEF owns input or controls are locked.

Raw `Key.bind` remains available for non-Foundations resources, but it does not participate in this
arbitration. Resources included in the Foundations stack should register through `Hmp.input`.

## Commands

A router belongs to the consuming resource. Register its `handle` function with `Events` from that
resource so the Framework retains correct resource ownership and removes the listener on reload.

```js
const commands = Hmp.command.createRouter({ prefix: "[robes]" });

commands.register("robe", {
    aliases: ["outfit"],
    usage: "/robe <me|nickname|#id>",
    guard: ({ player }) => player.connected || "You are not connected.",
}, ({ player, args, resolvePlayer, reply, usage }) => {
    const result = resolvePlayer(args[0] || "me");
    if (!result.ok) return reply(result.reason === "ambiguous" ? "That name is ambiguous." : usage);
    reply(`Selected ${Hmp.player.format(result.player)}.`);
});

Events.on("chatCommand", commands.handle);
```

Routers do not know about permissions. Give them a `guard` backed by `hmp-core` once Core owns the
server's authenticated groups and roles.

## Rate limiting

```js
const casts = Hmp.rateLimit.create({ limit: 6, windowMs: 1000 });

Events.onClient("spellCast", (player, payload) => {
    if (!casts.allow(player.id)) return;
    // Validate and process the advisory payload.
});
```

`take` returns the complete `{ allowed, used, remaining, dropped, resetAt }` result. Call `sweep`
from an existing maintenance tick when keys are unbounded; the limiter never creates its own timer.

## Validation and configuration

Validation functions return the accepted value and throw `TypeError`/`RangeError` on invalid input:

```js
const count = Hmp.validation.number(payload.count, {
    name: "count",
    coerce: true,
    integer: true,
    min: 1,
    max: 100,
});
```

Configuration paths are explicit. Pass `__dirname`-derived absolute paths from the consuming
resource; relative paths resolve from the server working directory.

```js
const config = Hmp.config.load(__dirname + "/../robes.config.js", {
    defaults: { enabled: true, maxSaved: 10 },
    required: false,
});
```

`config.merge` recursively merges plain objects, replaces arrays, and rejects prototype-pollution
keys. `config.env` contains strict boolean, number and JSON parsers.

## Localization and logging

```js
const language = Hmp.locale.create({
    en: { greeting: "Welcome, {name}." },
    fr: { greeting: "Bienvenue, {name}." },
}, { locale: "fr", fallback: "en" });

const log = Hmp.logger.create("robes", { level: "info" });
log.info(language.t("greeting", { name: player.nickname }));
```

See `types.d.ts` for the complete contract.
