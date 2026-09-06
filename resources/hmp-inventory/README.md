# hmp-inventory

`hmp-inventory` presents one inventory to the player while preserving two different authorities:

- **Custom items** are HMP rows in MySQL. They support icons, weight, stacks, slots, arbitrary JSON metadata and custom use handlers.
- **Native items** remain in the Framework's server-authoritative `player.inventory`. Potions, plants, ingredients, gear, tools and mounts can therefore still participate in Hogwarts Legacy systems.

The split is intentional. A made-up letter or evidence bag must never be injected into the game inventory, while a Wiggenweld Potion must remain in `HealthPotionStorage` so the game can see and consume it.

## Installation

Start the Foundations resources in dependency order:

```text
hmp-mysql
hmp-lib
hmp-core
hmp-characters
hmp-spawn
hmp-inventory
```

Configure `hmp-mysql`, then optionally create `data/hmp-inventory.json`:

```json
{
  "slots": 36,
  "maxWeight": 60,
  "autoSaveMs": 30000,
  "allowInventoryCommand": true,
  "ui": {
    "url": "fw://resources/hmp-inventory/dist/index.html"
  },
  "items": [],
  "startingItems": []
}
```

Players can open the bundled UI with `/inventory` or `/hmpinv`. A future input/wheel resource can call `ui.open(player)` instead.

## Starting items

`startingItems` is granted once per character, the first time it loads after being created.
Existing characters are never touched, so adding an entry later does not hand it out
retroactively. Each entry is a bare item name or an object:

```json
{
  "startingItems": [
    "housebroom",
    { "name": "sealed_letter", "amount": 3 },
    { "name": "native:wiggenweld_potion", "amount": 5 },
    { "name": "evidence_bag", "amount": 1, "metadata": { "issued": true } }
  ]
}
```

Names resolve through the same registry as `inventory.add`, so custom items, native
aliases (`native:wiggenweld_potion`) and raw native ids (`HouseBroom`) all work, and a
native entry lands in its game-authoritative holder exactly as a runtime grant would.
The grant is queued on `hmp:character:created` and applied after `hmp:character:loaded`,
once the character's container exists and the native bridge is attached. An unknown name
or a full/overweight inventory is logged and skipped; the character still loads.

`hmp-characters`' `startingGear` is the sibling knob for the four cosmetic gear pieces
vanilla grants during `WEK_01`; it patches the native inventory directly. Use
`startingItems` for everything that should go through the unified inventory (custom rows,
potions, resources, currency).

## Inventory appearance

The bundled **Arcanum** renderer is the default. It ships with its fonts and assets, so players do not
need access to an external font service. Basic item branding remains data-driven through item labels,
descriptions and icon URLs.

Servers may replace the entire inventory page without forking `hmp-inventory`. Host a page in another
resource and set its resource URL in `data/hmp-inventory.json`:

```json
{
  "ui": {
    "url": "fw://resources/my-inventory-ui/dist/index.html"
  }
}
```

`HMP_INVENTORY_UI_URL` can provide the same override through the process environment. Local pages must
use an `fw://resources/...` URL; externally hosted pages must use HTTPS.

Replacement pages implement the versioned `hmp.inventory.ui/v1` bridge:

- call `callEvent("ready")` after installing event listeners;
- listen for `configure`, whose detail contains the contract version;
- listen for `model`, whose detail is `HmpInventoryView` plus the display `title`;
- listen for `actionError` to present a rejected action if desired;
- call `callEvent("close", "{}")` or `callEvent("refresh", "{}")` for window actions;
- call `callEvent("use", JSON.stringify(target))`, where the target is either
  `{ source: "custom", slot }` or `{ source: "native", itemId, variation? }`.

The Foundations client bridge continues to own the view, focus and input lease. The server continues to
validate every action and remains the sole authority for item state. Contract additions will remain
backward-compatible within `v1`; a breaking message change requires a new contract version.

## Register a custom item

```js
const hmpInventory = Imports.get("hmp-inventory");

hmpInventory.items.register({
    name: "sealed_letter",
    label: "Sealed Letter",
    description: "Owl post with an unbroken Ministry seal.",
    icon: "fw://resources/my-resource/icons/sealed-letter.png",
    category: "Correspondence",
    weight: 0.05,
    maxStack: 20,
    resource: "my-resource",
});

await hmpInventory.inventory.add(player, "sealed_letter", 1, {
    metadata: { sender: "M. McGonagall", opened: false },
});
```

Metadata is part of a custom stack's identity. Two otherwise identical letters with different metadata occupy different stacks.

## Register a usable custom item

```js
hmpInventory.items.register({
    name: "healing_tonic",
    label: "Healing Tonic",
    icon: "fw://resources/my-resource/icons/tonic.png",
    category: "Brews",
    weight: 0.3,
    maxStack: 6,
    usable: true,
    consumable: true,
    resource: "my-resource",
    async use(context) {
        if (context.player.health >= 100) context.cancelled = true;
        else context.player.health = Math.min(100, context.player.health + 20);
    },
});
```

The handler runs on the server. A consumable is removed only after the handler and `hmp:inventory:using` listeners accept the use.

## Native items

Every inventoryable definition exposed by the Framework's `InventoryCatalog` is mapped automatically. The common potions, combat plants and ingredients retain friendly aliases such as `native:wiggenweld_potion`; native currency is exposed as `native:galleons` with a bundled coin icon. The compatibility name `native:knuts` resolves to that same definition and underlying native count—it is not a second item. Other definitions use a stable `native:<lowercase ItemDefinition id>` name such as `native:back_001_common`. Raw native IDs are also accepted case-insensitively as compatibility lookups, so `BroomHouse` and `native:broomhouse` resolve to the same registered item. You can re-register a mapping from another resource to supply a better label or custom icon:

```js
hmpInventory.items.register({
    name: "native:custom_broom",
    label: "Custom Broom",
    nativeId: "MyBroomDefinition",
    holder: "BroomStorage",
    kind: "mount",
    category: "Brooms",
    maxStack: 1,
    unique: true,
    icon: "fw://resources/my-brooms/icons/custom-broom.png",
    resource: "my-brooms",
});

await hmpInventory.inventory.add(player, "native:custom_broom", 1);
```

Definitions may carry a `referenceValue`: the server-owned worth of one unit in the base currency,
which economy resources such as `hmp-business` use to derive prices players must not set themselves
(shop buybacks). Native items take the game's `EconomyValue` when the host `InventoryCatalog`
exposes `economyValue`; custom items declare it at registration; items without one have no
reference worth and are never bought back.

Native holders matter. Potions on the potion wheel, resources, equipped mounts, stored mounts and gear are not interchangeable buckets. The `holder` field records the expected destination for display and review; the Framework's generated native catalog validates the item id and performs the actual holder routing. Equipping a mount is a separate holder move, not a second grant.

Definitions marked `usableFromInventory` by the Framework show a **Use item** action in the bundled UI. HMP routes that action through `player.inventory.use()` and waits for the game's exact native decrement proof before reporting success. Resources can invoke the same path directly:

```js
await hmpInventory.native.use(player, "native:wiggenweld_potion");
```

Unknown native rows are still shown in the UI with a readable fallback name and category. Registering a mapping later adds the desired label and icon without moving the native row.

## Persistence and character switching

On `hmp:character:loading`, the resource disables the Framework's identity-level `storage.json` persistence, loads that character's saved native snapshot from MySQL, and calls `player.inventory.replace()`. Character loading does not continue until the Framework confirms that exact inventory revision reached a terminal native state. Grants and removals use the same revision acknowledgement, while native use retains its exact one-item decrement proof. Every authoritative native update—including accepted potion consumption—is queued back to MySQL. Custom rows are already character-scoped.

This gives each HMP character an independent inventory today. When MafiaHub supplies server-validatable identities later, the account linkage in `hmp-core` can become verified without changing inventory ownership.

## Exports

- `items`: `register`, `unregister`, `get`, `fromNative`, `list`
- `inventory`: `get`, `add`, `remove`, `count`, `has`, `move`, `use`
- `containers`: durable named-container `create`, `get`, `remove` primitives
- `transfers`: atomic custom-item movement between character inventories and named containers
- `native`: direct mapped native `list`, `save`, `give`, `remove`, `use`
- `ui`: `open`, `close`, `refresh`, `isOpen`
- `status`: runtime health and pending native writes

## Container transfers

`transfers.move()` is the shared movement primitive for stashes, player trades, ground drops, evidence lockers and housing storage. It locks both containers in a stable order and commits the source removal and destination placement in one MySQL transaction. Stack metadata, slot limits, maximum stack sizes, uniqueness and destination weight are checked before either side is committed.

```js
const Inventory = Imports.get("hmp-inventory");

await Inventory.containers.create({
    key: "stash:auror-office",
    label: "Auror Evidence Locker",
    slots: 80,
    maxWeight: 500,
});

await Inventory.transfers.move({
    from: player,
    to: "stash:auror-office",
    fromSlot: 4,
    amount: 1,
});
```

A target can be an online player, an offline character id, or a named container key. The API is server-only and intentionally performs no distance, ownership or job-policy check; the calling stash, trade or evidence resource must authorize access before invoking it. There is no client event that accepts arbitrary container keys.

Framework-native items are intentionally rejected by this database transfer primitive. Moving a potion, piece of gear or Galleons out of the live game inventory would cross two authorities and needs a durable pending/recovery journal. Rejecting that boundary prevents a crash or retry from duplicating or losing native items.

## Events

- `hmp:inventory:changed` — authoritative add/remove/move completed
- `hmp:inventory:using` — cancellable live context before custom use consumption
- `hmp:inventory:used` — accepted custom item use completed
- `hmp:inventory:transferred` — an atomic custom container transfer committed

## Native catalog version

At startup, `hmp-inventory` reads the Framework's compiled catalog instead of carrying its own copy, so native ids, holders, stack limits, kinds and usability stay aligned with the installed mod. A small curated fallback remains for older Framework builds, but the current mod supplies the full catalog.
