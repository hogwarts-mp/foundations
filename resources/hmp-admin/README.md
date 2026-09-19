# hmp-admin

`hmp-admin` is Foundations's server-authoritative moderation and recovery resource. It provides a
staff menu built from `hmp-ui`, capability-based access through `hmp-core` groups, durable warnings
and identity bans, corrective actions across Foundations resources, and a persistent audit trail.

Open it with `/admin`. No privileged action is exposed as a client event: selections return to the
server and are authorized again before the action begins. An audit row is written before every
mutation and then marked completed or failed.

## Closed-test setup

Until the MafiaHub-backed verified identity provider is ready, configure a temporary secret in the
server process:

```text
HMP_ADMIN_BOOTSTRAP_SECRET=<a unique random secret of at least 16 bytes>
```

Staff without a verified admin identity can enter this secret in the masked `/admin` prompt. Access
exists only for that player connection and is discarded on disconnect or resource restart. The
secret is read only from the environment, is never stored in MySQL or configuration files, and
must not be sent through chat. Remove the environment variable once real identities are available.

Do not enable `HMP_ADMIN_UNSAFE_ASSERTED_BANS` for the test. Asserted fallback identities are not
stable enough for durable bans; staff can still warn, freeze, kick, and inspect those players.

## Capabilities

The default `admin` group grants capabilities cumulatively:

| Grade | Capabilities |
|---:|---|
| 1 | View players, kick, go to/bring, freeze/release, warn, announce, no-clip |
| 2 | Groups, employment, inventory, personal spell grants, banking, audit history, environment controls |
| 3 | Verified-identity bans and pending bank reconciliation |

Production access requires a `verified` identity by default. Once identities are live, assign a
staff account its role through a trusted server-side resource:

```ts
const Core = Imports.get("hmp-core");
await Core.groups.setAccount(accountId, "admin", 2, {
    source: "staff-provisioning",
});
```

The role mapping can be changed in `data/hmp-admin.json` with `roleRules`. Each rule has a group,
minimum grade, and capability list. `"*"` grants all known admin capabilities. The resource also
accepts `HMP_ADMIN_COMMAND`, `HMP_ADMIN_REQUIRE_VERIFIED`, and `HMP_ADMIN_CONFIG`.

## Tester-facing tools

- Connected-player inspection: account, character, identity trust, groups, world, game area/region, ping, position,
  and administrative freeze state.
- Moderation: durable warnings, kick, verified-identity timed or permanent bans, ban review/revoke.
- Intervention: acknowledged streamed go-to/bring and Framework-authoritative freeze/release.
- Staff movement: audited, server-authorized no-clip from the main menu, with camera-relative WASD,
  Space/Ctrl vertical movement, Shift boost, collision bypass, and protected landing.
- Corrections: server-filtered, searchable custom/native inventory items and spell grants,
  account/character groups, employment, and personal bank credits/debits in Galleons or another
  registered currency. Revoking a personal spell grant does not override a spell allowed by policy rules.
- Recovery: inspect and explicitly complete, compensate, or fail pending bank transactions.
- Audit: recent pending, completed, and failed actions with actor, target, reason, and error.

Standalone god mode and spectating are intentionally absent. Inventory corrections are limited to definitions
registered with `hmp-inventory`; native entries are routed through the Framework's authoritative catalog.
The inventory editor searches that catalog on the server first and sends at most 32 exact choices to the
client, keeping the dialog below the Framework event-payload limit even with thousands of native items.

No-clip tuning and movement keys can be overridden in the `noclip` object in `data/hmp-admin.json`.
The defaults are `4500` cm/s, a `3x` Shift boost, and QWERTY WASD movement.

## Suggested closed-test feedback

Ask testers whether they could identify the correct player, understand the consequence of each
action before confirming, recover from a mistake, and find enough audit detail afterward. Also
record any action they expected but could not perform, confusing terminology, overly broad role,
or situation where the menu lost context after a player disconnected.

## Exports

- `permissions`
- `players`
- `actions`
- `moderation`
- `audit`
- `ui`
- `status`
