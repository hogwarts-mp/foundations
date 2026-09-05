# hmp-shops

`hmp-shops` is Foundations's server-authoritative catalog, stock and transaction layer. Gameplay
resources register shops; `hmp-shops` supplies interaction prompts, menus, quantity/confirmation
dialogs, persistent limited stock, currency handling, inventory delivery and an audit ledger.

The built-in currency is player-facing **Galleons**. Hogwarts Legacy stores that balance internally
as the native `Knuts` item; `hmp-inventory` exposes it canonically as `native:galleons` and keeps
`native:knuts` as a compatibility alias to the same native count.

## Configuration

Copy `examples/config/data/hmp-shops.json` to `<server-root>/data/hmp-shops.json` (or point
`HMP_SHOPS_CONFIG` at a file) to declare shops in data. Each entry is a shop definition as below minus
anything a JSON file cannot carry: no `resource` (they are owned by `hmp-shops`), no `allow` predicates
and no handlers. They are registered after the service starts, so native items are available and a bad
entry is logged and skipped. The example places a potion vendor on the Hogsmeade high street.

## Registering a shop

Register inventory items before registering offers that reference them.

```ts
const Inventory = Imports.get("hmp-inventory");
const Shops = Imports.get("hmp-shops");

Inventory.items.register({
    name: "school_robe",
    resource: "hmp-clothing",
    label: "Hogwarts School Robe",
    description: "A plain student robe.",
    icon: "fw://resources/hmp-clothing/icons/robe.png",
    maxStack: 1,
    unique: true,
});

const unregister = Shops.shops.register({
    id: "gladrags",
    resource: "hmp-clothing",
    label: "Gladrags Wizardwear",
    description: "Fine clothing for every occasion.",
    currency: "galleons",
    requirements: { character: true },
    interaction: {
        position: { x: 1234, y: 5678, z: 310 },
        areaId: "Hogwarts",
        radius: 250,
        object: {
            model: "/Game/Environment/.../SM_ShopCounter.SM_ShopCounter",
            yaw: 90,
        },
        // Optional vendor body: a stationary dressed human at the same spot (see hmp-interact).
        character: { characterId: "AugustusHill", yaw: 90, label: "Augustus Hill" },
    },
    offers: [
        {
            id: "school-robe",
            item: "school_robe",
            buyPrice: 120,
            sellPrice: 45,
            stock: 10,
            maxQuantity: 1,
        },
        {
            id: "wiggenweld",
            item: "native:wiggenweld_potion",
            buyPrice: 25,
            stock: null, // unlimited
            maxQuantity: 12,
        },
    ],
});
```

When `interaction` is present, the resource registers `shop:<id>` with `hmp-interact`. Omitting it
creates an API-only shop that can be opened from an NPC dialogue, command, quest or other server flow:

```ts
await Shops.shops.open(player, "gladrags");
```

The UI presents at most 24 offers. Prices, balances, stock, owned counts and enabled actions are built
on the server. The client only answers the exact menu/input/confirmation requests offered by
`hmp-ui`; it never sends a price, currency, item name or arbitrary purchase payload.

## Direct transactions

```ts
const purchase = await Shops.transactions.buy(player, "gladrags", "wiggenweld", 3, {
    reference: `quest-reward:${questId}:${characterId}`,
});

const sale = await Shops.transactions.sell(player, "gladrags", "school-robe", 1);
```

A caller-supplied `reference` is an idempotency key. Replaying a completed reference returns the
original transaction without moving stock, money or items again. References are globally unique and
may contain letters, numbers, `.`, `_`, `:`, and `-`.

Completed purchases emit `hmp:shop:purchased`; completed sales emit `hmp:shop:sold`. Each payload
contains the player, active character, normalized shop and offer, and completed transaction.

## Stock

Omitting `stock` or setting it to `null` means unlimited stock. A number establishes the initial
persistent quantity; restarting or re-registering a shop does not overwrite the current quantity.

```ts
await Shops.stock.get("gladrags", "school-robe");
await Shops.stock.set("gladrags", "school-robe", 20);
await Shops.stock.adjust("gladrags", "school-robe", 5);
```

Buying reserves limited stock before charging. Selling adds the item back to limited stock.

## Custom currencies

`hmp-banking` can register character bank balances without changing shop code:

```ts
const Banking = Imports.get("hmp-banking");

Shops.currencies.register(Banking.providers.shops({
    id: "bank-galleons",
    resource: "hmp-economy",
    currency: "galleons",
    label: "Banked Galleons",
}));
```

Currency methods must be atomic at their own boundary: `debit` returns `false` without changing the
balance when funds are insufficient, `true` only after the entire debit, and `credit` returns `true`
only after the entire credit. Throw before applying a mutation when an operation cannot be completed.

## Requirements

Shops and individual offers support:

- an active character;
- `all` or `any` hmp-core group requirements;
- hmp-inventory item and exact-metadata requirements;
- an asynchronous `allow(context)` callback that returns `true`, `false`, or a denial message.

Offer callbacks receive `direction: "buy" | "sell"` so availability can differ by action.

## Consistency model

Transactions are serialized per player. Limited stock and the idempotent ledger are persisted in
MySQL. Inventory and currency changes are checked for exact moved amounts; failures trigger reverse
operations and stock release, recorded as `compensated` when successful.

MySQL, custom inventory and Framework-native inventory cannot participate in one database transaction.
A process crash at the exact boundary between those systems can leave a `pending` ledger row requiring
operator reconciliation. The transaction history deliberately preserves that evidence instead of
pretending cross-system ACID guarantees exist.
