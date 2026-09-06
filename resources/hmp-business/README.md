# hmp-business

`hmp-business` turns a job into a player-run business. A business is one `hmp-jobs` job and its
`hmp-banking` organization account; it may run any number of counters, each a real `hmp-shops` shop
with its own position, vendor body, offers and persistent stock. Employees holding the job permission
`shop.manage` set prices, restock from their own inventory, move stock between counters, open and
close counters and read the books. Administrators create the business and place the counters.

`hmp-shops`, `hmp-jobs` and `hmp-banking` are not modified. This resource owns the shop registrations
on the job's behalf, registers a per-business till as an `hmp-shops` currency provider, and meets the
other resources only through their public APIs and `hmp-core` groups.

## Worked example

An administrator makes the character Josh the head of J. Pippin's Potions.

1. A gameplay resource registers the job with a top grade carrying `shop.manage`:

```ts
Jobs.jobs.register({
    id: "pippins",
    resource: "hmp-hogsmeade",
    label: "J. Pippin's Potions",
    grades: [
        { level: 0, label: "Shop Assistant", salary: 10, bankPermissions: ["view"] },
        { level: 5, label: "Manager", salary: 25, permissions: ["employees.manage"], bankPermissions: ["deposit", "withdraw"] },
        { level: 10, label: "Head Brewer", salary: 50, permissions: ["shop.manage"], bankPermissions: ["manage"] },
    ],
    banking: { organizationId: "pippins", currency: "galleons" },
    payroll: { intervalMs: 3_600_000, requireDuty: true, source: "organization" },
});
```

2. The administrator creates the business, stands at the counter and places it, then seeds the shelf:

```text
/business create pippins pippins J. Pippin's Potions
/business shop pippins hogsmeade Hogsmeade counter
/business vendor pippins hogsmeade PercivalPippin 30
/business dutypoint pippins hogsmeade
/business offer pippins hogsmeade native:wiggenweld_potion 25 0.4 6 wiggenweld
/business stock pippins hogsmeade wiggenweld 12
```

3. Josh is hired at grade 10 from the hmp-admin Employment menu and the organization account is
   credited from the Banking menu. From then on Josh opens the management menu, sets prices, restocks
   from the potions he carries, hires staff through `hmp-jobs`, and draws a wage from the same account
   the till pays into.

The same business can be declared in `data/hmp-business.json` instead; see Configuration.

## How a counter is registered

Every enabled counter of an enabled business is registered with `hmp-shops` as
`business:<business>:<counter>`, owned by `hmp-business`. The registration carries:

- `currency: "business:<business>"`, a till provider that debits the buyer's personal bank account
  and credits the organization account in one bank transfer, and pays staff selling back to the shop
  from the organization account. A purchase fails cleanly when the buyer lacks funds; a buyback fails
  cleanly when the till is empty.
- the counter's position, area and radius, and the vendor body while nobody is on duty at that
  counter (see staffing below);
- one `hmp-shops` offer per enabled business offer. Stock stays in `hmp-shops`' own table keyed by
  the counter, so two counters selling the same potion hold separate supplies. Offers a manager
  creates always track finite stock; only an administrator can list an `unlimited` offer.
- an offer-level `allow` predicate so only members of the job group may sell back to the shop, and
  never a holder of `shop.manage` (see Buybacks).

Counters are registered when the resource starts, after every edit, and again on duty transitions.
A business whose job is not registered yet stays unpublished and is retried whenever another resource
starts. A counter with no enabled offers is withdrawn from `hmp-shops` until one is listed.

### Staffing

| Policy | Opens | Vendor body |
|---|---|---|
| `always` | always | shown while nobody is on duty at the counter |
| `staffed` | only while an employee is on duty within `staffRadius` of the counter; customers are otherwise told "Nobody is at the counter." | shown while nobody is on duty at the counter |
| `kiosk` | always | never |

"On duty at the counter" means `Jobs.duty.list(jobId)` contains a connected player standing within
the counter's `staffRadius` (centimetres, default 1000). Duty is per job, not per counter, so the
same staff cover every counter of the business. The vendor body is refreshed on `hmp:jobs:duty`
events; an employee who walks away while clocked in leaves a `staffed` counter refusing customers
until the next duty change re-evaluates the body.

### Buybacks

Buybacks are **off by default**: no counter buys anything from anyone, offers carry no sell price,
and the management menu shows no buyback field. This matches the buy-only shops of ox_inventory and
qb-shops and is the safe policy, because an owner-set buyback price would let a manager drain the
till by selling one potion to their own counter at a price near the ceiling.

Set `prices.buybacks.enabled` to turn them on. A buyback price is then never owner-set. It is
`buybackRatio × referenceValue`, rounded down, where:

- `buybackRatio` is per offer in `0..1`. Managers set it from the Prices menu, capped by
  `prices.buybacks.maxRatio` (default `0.5`).
- the reference value comes from the server: `prices.buybacks.referenceValues` in the config wins,
  otherwise the `referenceValue` on the `hmp-inventory` item definition (the game's `EconomyValue`
  for native items once the host catalog exposes it, or a value the registering resource declares).
  An item without a reference value is never bought back, whatever the ratio.
- holders of `shop.manage` may not sell to their own counters even when buybacks are on; their
  income is wages and permitted organization withdrawals. Collusion between a manager and a clerk
  remains possible and is left to the ledgers, which name both parties.

A raw `sellPrice` survives only as an administrator-set field on sell-only offers (an ingredient
buyer that sells nothing), so a pawn counter can still be declared in data or with
`/business offer <business> <counter> <item> - <price>`. It too pays only while buybacks are enabled.

### Clock-in zones

A counter may carry a surveyed `dutyPoint`. `hmp-business` then registers an `hmp-interact` zone
`business:<business>:<counter>:duty` for the job group that toggles `hmp-jobs` duty, so staff can
clock in where they work. It is separate from the shop prompt because the client shows one prompt
per spot; survey it a step away from the counter (`/business dutypoint`). Without a duty point the
job's own `dutyPoints` apply.

## Management menu

`Business.ui.manage(player)` opens the menu for businesses the player manages through `shop.manage`;
`Business.ui.manage(player, "pippins")` opens one directly. Wire it to a command, an interaction or
the employment menu from a gameplay resource. The menu offers:

1. **Prices**: what customers pay within the configured bounds and, when buybacks are enabled and the
   item has a reference value, the buyback share.
2. **Restock from inventory**: items the player carries move onto the shelf; a failed shelf write
   returns them.
3. **Withdraw to inventory**: capped at the current stock; a failed grant returns stock to the shelf.
4. **Transfer stock** between counters without an inventory round-trip.
5. **Add an offer** for any registered item, or **retire and restore** one. Retiring hides the offer
   and keeps its stock and ledger history.
6. **Counters**: open or close, staffing policy and vendor body. Placing or moving a counter stays
   administrator-only because it needs a surveyed position.
7. **Books**: organization balance, today's sales per counter and stock levels.

Everything the menu does is also available through the API with `actor` set to the acting player or
character id. An omitted `actor` or `admin: true` marks a trusted caller: the `shop.manage` check is
skipped and administrator-only operations are allowed, while the actor is still written to the
ledger.

```ts
const Business = Imports.get("hmp-business");

await Business.offers.setPrices("pippins", "hogsmeade", "wiggenweld", { buyPrice: 30, buybackRatio: 0.4 }, { actor: player, reason: "Winter prices" });
Business.offers.buybackPrice("pippins", "hogsmeade", "wiggenweld"); // null while buybacks are off
await Business.stock.restock(player, "pippins", "hogsmeade", "wiggenweld", 6);
await Business.stock.transfer("pippins", "hogsmeade", "stall", "wiggenweld", 4, { actor: player });
await Business.shops.update("pippins", "hogsmeade", { staffing: "staffed" }, { actor: player });
const books = await Business.books.summary("pippins", { actor: player });
```

Errors carry codes: `HMP_BUSINESS_ACCESS`, `HMP_BUSINESS_ADMIN`, `HMP_BUSINESS_NOT_FOUND`,
`HMP_BUSINESS_SHOP`, `HMP_BUSINESS_OFFER`, `HMP_BUSINESS_ITEM`, `HMP_BUSINESS_ITEMS`,
`HMP_BUSINESS_STOCK`, `HMP_BUSINESS_QUANTITY`, `HMP_BUSINESS_BUSY`, `HMP_BUSINESS_BANK`,
`HMP_BUSINESS_CURRENCY`, `HMP_BUSINESS_EXISTS`, `HMP_BUSINESS_SHOP_EXISTS`, `HMP_BUSINESS_CHARACTER`,
`HMP_BUSINESS_BUYBACK`.

## Administration commands

`/business` is registered when `commands.enabled` is true and guarded by `commands.adminGroups`
(`hmp-core` groups). Every action is written to the ledger with the administrator's character.

```text
/business list | audit <business> [limit] | sync
/business create <business> <job> [label…] | remove <business>
/business shop <business> <counter> [label…]         placed where you stand
/business dutypoint <business> <counter> [clear]     placed where you stand
/business vendor <business> <counter> <characterId|none> [yaw] [label…]
/business staffing <business> <counter> <always|staffed|kiosk>
/business open <business> <counter> | close <business> <counter>
/business offer <business> <counter> <item> <buy|-> [buyback|-] [max] [offerId]
/business retire <business> <counter> <offer> | restore <business> <counter> <offer>
/business stock <business> <counter> <offer> <quantity>
/business manage [business]
```

`buyback` is the 0..1 share of the reference value, or the raw price when `buy` is `-` (a sell-only
offer). Removing a business deletes its counters and offers; its ledger rows and the `hmp-shops` stock rows
remain.

## Configuration

Copy `examples/config/data/hmp-business.json` to `<server-root>/data/hmp-business.json` (or point
`HMP_BUSINESS_CONFIG` at a file).

```json
{
  "prices": {
    "floor": 1, "ceiling": 1000000, "ceilings": { "galleons": 100000 },
    "buybacks": { "enabled": false, "maxRatio": 0.5, "referenceValues": { "native:wiggenweld_potion": 20 } }
  },
  "houseCut": { "percent": 0, "organizationId": "treasury", "label": "Treasury", "currency": "galleons" },
  "commands": { "enabled": true, "command": "business", "adminGroups": [{ "key": "admin", "minimumGrade": 1 }] },
  "businesses": []
}
```

- `prices`: bounds for every buy and sell price a manager or administrator sets; `ceilings` is keyed
  by currency and overrides `ceiling`. `buybacks` is the policy described above; `referenceValues`
  overrides item reference values by item name.
- `houseCut`: a whole-number percentage of every purchase moved from the organization account to the
  treasury organization, keyed by the shop transaction reference so a replayed purchase never pays
  twice. When no organization with that id is registered, `hmp-business` registers a treasury of the
  given currency. `0` disables the cut.
- `businesses`: businesses to create the first time the resource starts with them absent. Each entry
  is a business definition with `shops`, each shop carrying `offers` that may set an initial `stock`.
  Existing businesses are never overwritten by the file; edits happen in the game or through the API.

The example file declares Pippin's with its Hogsmeade counter. It only comes alive once a gameplay
resource registers the `pippins` job; until then the resource logs that it is waiting. Remove the
data-declared `pippins` entry from `data/hmp-shops.json` when switching to the player-run version,
or both vendors stand on the same spot.

## Ledger and events

Every price change, restock, withdrawal, transfer, offer change, counter change and business change
is written to `hmp_business_audit` with the acting character, the state before and after, and the
reason. `Business.audit.history(businessId, limit)` reads it newest first.

Events emitted after successful changes: `hmp:business:changed`, `hmp:business:shop`,
`hmp:business:offer`, `hmp:business:stock`.

The books tally purchases and buybacks per counter from `hmp:shop:purchased` and `hmp:shop:sold` for
the current local day, in memory; they reset when the resource restarts. The bank ledger and the
`hmp-shops` transaction history remain the durable records.

## Consistency model

Stock lives in `hmp-shops`' MySQL table and inventory lives in the game; the two cannot share one
transaction. Restock removes the items first and returns them when the shelf write fails; withdraw
reserves the stock first and returns it when the inventory grant fails; transfers debit the source
before crediting the destination and refund on failure. Stock movements are serialized per player.

Purchases are one `hmp-banking` transfer between the buyer's personal account and the organization
account, applied inside the bank's own database transaction and keyed by the `hmp-shops` reference,
so compensation and replay stay auditable through the bank ledger.

## Exports

- `businesses`
- `shops`
- `offers`
- `stock`
- `books`
- `ui`
- `audit`
- `status`
