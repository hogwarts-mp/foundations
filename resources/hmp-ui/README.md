# hmp-ui

`hmp-ui` is the shared presentation primitive layer for Foundations resources. Its call-site model is intentionally similar to ox_lib: resources ask for a notification, alert, input dialog, context menu or progress operation and receive a normal value or Promise.

The resource owns one browser view and serializes modal work through it. Notifications remain
unfocused. Dialogs and cancellable progress acquire focus through `Web.focusView()` and hold an
owner-scoped `hmp-lib` control lease until the dialog closes. A resource reload therefore cannot
leave an orphaned UI lock behind.

The bundled renderer uses Arcanum as its default visual language. Select fields are rendered as DOM
menus rather than native browser popups because off-screen CEF does not composite native dropdown
windows. Server owners can replace the client renderer while retaining the same normalized UI API.
Chained dialogs reuse the focused view for a short handoff window, keeping the dimmed backdrop
continuous while a server resource prepares the next menu.

It depends only on `hmp-lib`. Character, inventory and other domain screens remain resource-owned.

## Server usage

```js
const UI = Imports.get("hmp-ui");

UI.notify(player, {
    title: "Owl Post",
    description: "A new letter has arrived.",
    tone: "success",
});

const answer = await UI.alert(player, {
    title: "Delete this character?",
    content: "This action cannot be undone.",
    confirmLabel: "Delete",
    cancel: true,
});

if (answer !== "confirm") return;
```

Input dialogs return a keyed object rather than a positional array:

```js
const values = await UI.input(player, {
    title: "List an item",
    fields: [
        { name: "price", label: "Price", type: "number", min: 1, required: true },
        { name: "note", label: "Description", type: "textarea" },
    ],
});

if (values) console.log(values.price, values.note);
```

Pre-filtered catalogs can use the same select contract with client-side search. A dialog accepts at most
192 options per select, and the complete request must remain below the safe event-payload budget. Resources
with larger catalogs should first collect a server-side search term, then offer the matching subset. The
submitted value must still be one of the exact options supplied and is revalidated on the server:

```js
const values = await UI.input(player, {
    title: "Give item",
    fields: [{
        name: "item",
        label: "Item",
        type: "select",
        searchable: true,
        required: true,
        options: matchingItems.slice(0, 32).map((item) => ({
            label: item.label,
            value: item.name,
            description: item.category,
        })),
    }],
});
```

Context menus return only an offered option ID. The server revalidates the response against the exact request, rejecting invented and disabled options:

```js
const choice = await UI.context(player, {
    title: "Potion station",
    options: [
        {
            id: "brew",
            title: "Brew potion",
            description: "Uses the selected recipe.",
            icon: "fw://resources/my-potions/icons/cauldron.png",
        },
        { id: "collect", title: "Collect ingredients" },
    ],
});
```

Context icons are optional absolute `http` or `https` URLs. Unsafe schemes are discarded before
the menu reaches the browser view.

Progress resolves `true` after its duration and `false` when cancelled, closed, timed out or disconnected:

```js
if (await UI.progress(player, { label: "Brewing Wiggenweld…", duration: 5000, canCancel: true })) {
    // Apply the server-side result now.
}
```

## Client usage

Client resources receive the same export names and promise shapes through `Imports.get("hmp-ui")`. This is useful for presentation-only flows; authoritative decisions should originate on the server.

## Contract and safety

- All rendered text is plain text, length-limited and control-character cleaned.
- One player can have multiple server requests pending, but the client presents them sequentially.
- Every response carries an opaque request ID and is accepted only from its intended player.
- Input values and context selections are validated again on the server.
- Timeouts and disconnects settle Promises rather than leaving gameplay coroutines hanging.
- A full `close(player)` settles and clears that player's outstanding requests.

## Exports

- `notify(player?, notification)`
- `alert(player?, dialog)`
- `input(player?, dialog)`
- `context(player?, menu)`
- `progress(player?, progress)`
- `close(player?, reason?)`
- `status()`

Server exports take a player first. Client exports omit it.
