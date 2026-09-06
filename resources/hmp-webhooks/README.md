# hmp-webhooks

`hmp-webhooks` is the optional, server-only outbound webhook service for HMP Foundations. It owns
named destinations, bounded per-destination queues, request timeouts, retry/backoff, provider payload
formatting, and selected server-event relays. Webhook failures never gate gameplay and the resource
uses `errorBehavior: "continue"`.

Discord is the first and currently supported provider. The service keeps normalized rich messages and
provider formatting separate so another provider can be added without changing callers. Discord URLs
are validated as HTTPS webhook endpoints, are never returned by `status()`, and should be injected via
environment variables rather than committed to a configuration file.

## Configuration

Copy `examples/config/data/hmp-webhooks.json` to the server's `data` directory and inject the URL named
by each destination's `urlEnv`:

```text
HMP_WEBHOOKS_ENABLED=true
HMP_WEBHOOKS_DISCORD_URL=https://discord.com/api/webhooks/...
```

Foundations does not read `.env` files. Put these variables in the service manager, container, or
server launch environment. A destination can use a different secret by changing `urlEnv`; this permits
separate `gameplay`, `moderation`, or `errors` destinations. A literal `url` is accepted for deployments
with a protected `data` directory, but the example intentionally contains no secret.

Each destination configures:

- `provider` — currently `discord`;
- `urlEnv` or `url` — environment variable name or literal endpoint;
- `username` and `avatarUrl` — provider presentation defaults;
- `minIntervalMs` and `queueLimit` — bounded delivery pacing;
- `maxAttempts`, `retryBaseMs`, and `requestTimeoutMs` — failure handling.

When a queue is full, the oldest pending message is discarded and the new message is retained. Discord
rate-limit responses honor `Retry-After` before exponential backoff is used. Queues are deliberately
in-memory: these are secondary notifications, not an audit store.

## Sending messages

Declare `hmp-webhooks` as a dependency when delivery is required, import it, and address a configured
destination by name:

```ts
import type { HmpWebhooks } from "../../hmp-webhooks/types";

const Webhooks = Imports.get<HmpWebhooks>("hmp-webhooks");
const accepted = Webhooks.send("discord", {
    title: "Potion brewed",
    description: `${character.name} finished a Wiggenweld potion.`,
    color: 0x3ba55d,
    fields: [{ name: "Quality", value: "Excellent", inline: true }],
    timestamp: new Date().toISOString(),
});
```

`send` returns whether the message entered the in-memory queue, not whether the remote endpoint
eventually accepted it. `status()` reports pending, delivered, failed, and dropped counts without
revealing endpoint URLs.

For optional announcements, prefer emitting a domain event and allowing `hmp-webhooks` to observe it.
That keeps gameplay resources usable without this optional integration.

## Built-in event relays

The configuration can independently route:

- `hmp-gauntlet:complete` results;
- `hmp:activities:completed`, filtered by activity ID (the example selects `duel:standard`);
- `hmp:spells:cast`, filtered by spell name.

Spell casts are explicitly labeled as client-reported advisory events. They are useful as activity
notifications but are not authoritative moderation or audit evidence. An empty `only` list accepts all
values and can be very noisy.

## Development

```text
npm run test --workspace hmp-webhooks
npm run typecheck --workspace hmp-webhooks
npm run build --workspace hmp-webhooks
npm run smoke --workspace hmp-webhooks
```
