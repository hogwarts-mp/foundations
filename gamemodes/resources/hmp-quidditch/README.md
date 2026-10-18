# hmp-quidditch

`hmp-quidditch` is the Foundations version of the HogwartsMP Quidditch resource. It keeps the
server-authoritative pitch simulation: the physical Quaffle, the flying Snitch, hoops, bludgers, roles,
scoring, reconnectable seats, goal banners, scoreboard and results overlay. Its shared concerns run on
Foundations.

## The pitch

Everything on the pitch is a server `WorldObject`:

- **Quaffle**: a physics object. The nearest client simulates it while it is loose and reports its pose
  back. A carrier holds it attached to their hand, and a throw sets its velocity. Goals are a segment
  test against the hoop planes, run on the server from that pose.
- **Snitch**: the game's `BP_Loose_Snitch` Blueprint, flown by one elected client for everyone. The
  server's flight model only steers it, and a catch is judged against where its simulator says it is.
- **Hoops**: race-ring Blueprints placed from the pitch geometry.
- **Bludgers**: moved by the server every tick; every client interpolates them.

No client reports where anything is, so no client can move the ball or the snitch for anyone else.

Every pitch object is created with `drawDistance: pitch.propDrawDistance`, which defaults to **0**:
never cull. A client draws it from anywhere it streams to (every player within 500 m), so the ball,
snitch, bludgers, hoops and banners stay visible across the whole pitch and stands. Without it the
game hides a small spawned prop past about 15 to 20 m. It needs a HogwartsMP host whose
`WorldObject.create` takes `drawDistance`; an older host ignores the option and keeps that limit.

## Foundations integration

- `hmp-activities` mirrors forming and running sessions for discovery, exclusivity, and lifecycle.
- `hmp-core` stores career goal and Snitch totals against the active character, and its groups decide
  who may manage a match.
- `hmp-houses` supplies and synchronizes character house membership used by fixtures.
- `hmp-inventory` checks and grants the configured native broom through the persistent native API.
- `hmp-ui` renders the manager, fixture, position-selection and live tuning dialogs, and notifications.
- `hmp-lib` owns client shortcuts, logging, and shared resource cleanup.
- `hmp-interact` owns the pitch interaction instead of the legacy global `interactables` resource.
- `hmp-audio` owns stadium ambience and gameplay cues.
- `hmp-blips` publishes the Quaffle, Snitch, and bludger markers from the server's own positions.
- `hmp-world` owns world policy; client teardown restores the latest one. A match leaves the server-wide
  encounter policy alone: server camps only spawn when players approach them, and switching them off would
  despawn every camp for everyone.

The resource-specific, non-focused banner, scoreboard, and results overlays remain local. They are
flight HUDs rather than modal application UI, so they deliberately do not take mouse or keyboard focus.

## Modes

| Mode | Players | Description |
|---|---:|---|
| `snitchHunt` | 1+ | Seekers catch the Snitch by remaining inside its catch radius. |
| `practice` | 1+ | Hoops and a Quaffle without bludgers or a Snitch. |
| `match` | 2+ | Chasers, beaters, keepers, seekers, goals, bludgers, and a match-ending Snitch. |

## Calling a match

`/quidditch call` (or the manager) tells the eligible players with a small card on the right of
their screen, nothing more: the fixture, the mode, how long the call stays open, how full each side is,
and their own pick. It never takes focus, so anyone who does not want to play can ignore it. It goes
away when the call is started or called off. Pressing the card's key (`lobby.joinKey`, default `J`)
opens the position picker; so do `/quidditch join` and the pitch interaction. The referee starts or
calls off the match from the same picker.

## Match control

Calling, starting, stopping and tuning a match is gated by `control` in `quidditch.config.js`:

```js
control: {
    who: "staff",            // or "anyone"
    group: "admin",          // the hmp-core group that counts as staff
    minimumGrade: 1,
    anyoneWhenNoStaff: true, // nobody qualifying online: anyone may run a match
},
```

Taking a seat, picking a team or position, and playing are never gated.

## Manager

`/quidditch manager` opens the manager: call a match, start one immediately, open the lobby, stop the
session, or go to the pitch. It also holds:

- **Tune the pitch**: one dialog per section (Snitch, Bludgers, Keeper, Bat, Banners, Hoops) of sliders
  that apply live as they are dragged. **Keep** leaves them; **Revert** or closing puts the section back.
- **Snitch controls**: freeze (the catch test keeps running), bring it to you, release it now, reset a
  catch, or toggle its marker.
- **Bludger controls**: freeze them, or toggle their markers.
- **Beater bat**: choose the bat and the socket it rides.

Tuned values last until the resource restarts; `quidditch.config.js` holds the defaults.

## Commands

```text
/quidditch
/quidditch manager
/quidditch call <house> <house> [mode]
/quidditch call ffa [mode]
/quidditch lobby
/quidditch join
/quidditch start <mode> [solo]
/quidditch stop
/quidditch team <house>
/quidditch role <chaser|beater|keeper|seeker>
/quidditch pitch
```

Closed-test tuning commands from the original resource remain available, including `ball`, `cast`,
`hoops`, `hoopheight`, `trail`, `bludgers`, `bat`, `banner`, `bannertest`, `results`, `ballwhere`, and
`unstick`. The ones that change a match follow the match-control rule above.

Default in-match shortcuts are `E` pickup, `Q` pass, `R` shoot, `V` swing, `B` block, and `T` tackle.
They are registered through `hmp-lib`; the server revalidates range, role, possession, and session
state for every action.

## Runtime exports

- `status()`
- `call(referee, mode?, teamA?, teamB?, ffa?)`
- `start(starter, mode?, solo?)`
- `stop(reason?)`

## Build and verification

From the Foundations repository root:

```text
npm install
npm run build -w hmp-quidditch
npm test -w hmp-quidditch
npm run smoke -w hmp-quidditch
```

`npm test` runs the integration contract and a behaviour test of the server script against fakes. The
pitch needs a HogwartsMP build whose `WorldObject` supports physics objects, carried objects and
simulated Blueprints (`physics`, `simulated`, `attachTo`, `setVelocity`).
