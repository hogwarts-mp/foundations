# hmp-interact

`hmp-interact` is Foundations's shared, server-authoritative “walk up and press F” layer. It owns the
single interaction key and world prompt, while gameplay resources register zones and handlers on the
server. The client chooses what to display; it never decides whether an action is legal.

## Basic interaction

Coordinates and radii are Hogwarts Legacy world centimetres. Author zone positions at the same
height as `player.position` for intuitive spherical distance checks.

Set `areaId` and, when needed, `regionId` to prevent coordinate collisions between game maps.
`hmp-interact` filters client snapshots and server-side triggers against `player.location()`, then
resends the snapshot on `playerLocationChanged`. No prompt is available while world travel reports a
null location.

```ts
const Interact = Imports.get("hmp-interact");

const unregister = Interact.register({
    id: "ollivanders.counter",
    resource: "hmp-shops",
    label: "Browse wands",
    description: "Ollivanders wand selection",
    position: { x: 1234, y: 5678, z: 310 },
    areaId: "Hogwarts",
    radius: 250,
    requirements: {
        character: true,
        groups: [{ key: "student", minimumGrade: 0 }],
    },
    async handler({ player }) {
        // Open the shop here. Position and requirements were just revalidated.
    },
});

// Resource shutdown can call this explicitly. The ownership field also lets
// hmp-interact remove every registration when it receives resourceStop.
unregister();
```

Registration IDs are globally unique. Re-registering an ID from the same resource replaces it;
another resource cannot take ownership of it.

## Menus, items and progress

Multiple options use `hmp-ui`'s context menu. Disabled options are computed by the server. The chosen
option, distance and requirements are all checked again before its handler runs.

```ts
Interact.register({
    id: "potions.cauldron.1",
    resource: "hmp-potions",
    label: "Cauldron",
    position: { x: 1200, y: 5600, z: 310 },
    radius: 220,
    exclusive: true,
    options: [
        {
            id: "brew.wiggenweld",
            label: "Brew Wiggenweld",
            description: "Uses one Horklump Juice.",
            requirements: { items: [{ name: "horklump_juice", amount: 1 }] },
            progress: { label: "Brewing Wiggenweld", duration: 5000, canCancel: true },
            cooldownMs: 1000,
            async handler({ player }) {
                // Consume ingredients and grant the potion transactionally in hmp-potions.
            },
        },
    ],
});
```

Structured requirements support an active character, `all` or `any` hmp-core groups, hmp-inventory
items (including exact metadata), and an asynchronous custom `allow(context)` predicate. Returning a
string from `allow` denies the action with that message.

## Optional world objects

An interaction can own a replicated Framework `WorldObject`. Omit `object` for an invisible zone
around an existing level object or NPC.

```ts
Interact.register({
    id: "notice.daily-prophet",
    resource: "hmp-news",
    label: "Read the Daily Prophet",
    position: { x: 100, y: 200, z: 300 },
    radius: 250,
    promptOffsetZ: 150,
    object: {
        model: "/Game/Gameplay/Stations/Interaction/MailInteraction/Props/SM_HGW_BulletinBrd.SM_HGW_BulletinBrd",
        yaw: 90,
        collision: true,
    },
    handler({ player }) {
        Imports.get("hmp-ui").notify(player, "Sirius Black remains at large.");
    },
});
```

The object is created under `hmp-interact:<id>` and destroyed when the registration or owning
resource is removed. `hmp-interact` draws the prompt itself, so the object does not receive a second
native prompt.

`model` is a full StaticMesh asset path in `/Root/Dir/Name.Name` form — the package path with the
object name repeated after the dot, exactly as the example shows. Any mounted content root works,
including a mod pak's, so a numeric catalog id is only a shorthand for the meshes the server ships
with. `register` throws if the path is malformed.

To find a path, press **F6** in-game for the World builder and search; hovering a result shows its
full path. A well-formed path to an asset that does not exist is accepted by the server and simply
never renders, so check the client log if a prop's prompt appears without its mesh.

## Optional characters

An interaction can instead own a replicated Framework `Character`: a dressed, stationary human built
from a registry character id, standing at the interaction's own position so the prompt can never
drift from the body. It has no AI, no health and never moves. `position` is the pawn origin (a
player's `position`, about 90 cm above the feet); `promptOffsetZ` defaults to 40 (chest height) for a
character, and an optional `label` draws a nameplate above the head.

```ts
Interact.register({
    id: "shop.ollivander",
    resource: "hmp-shops",
    label: "Browse wands",
    position: { x: 100, y: 200, z: 300 },
    radius: 250,
    character: { characterId: "GerboldOllivander", yaw: 90 },
    handler({ player }) {
        // open the shop
    },
});
```

`characterId` must be one of the human registry ids below (`Character.isAllowed(id)` checks at
runtime; `register` throws otherwise). Non-human rigs — house-elves, goblins, centaurs, ghosts — are
deliberately absent because they break the proxy build. Cuthbert Binns is on the list only because
the game files him as a professor; expect his look to be odd.

| Group | Ids |
|---|---|
| Vendors | AgnesCoffey, AlbieWeekes, AugustusHill, BernardNdiaye, CalliopeSnelling, ClaireBeaumont, CliffordCromwell, CrispinDunn, EddieThistlewood, EdgarAdley, EwartMacquod, FatimahLawang, FlorenceGreen, GerboldOllivander, HermenegildaNavarro, IndiraWolff, JalalSehmi, LeonaPeck, LeopoldBabcocke, PadraicHaggarty, PercivalPippin, PriyaTreadwell, RohanPrakash, ThomasBrown, TimothyTeasdale |
| Generic shopkeepers | VENDORCauldronShop, VENDORJokeShop, VENDORMusicShop, VENDORQuillShop, VENDORSecondHandShop1, VENDORTeaShop |
| Townspeople | AesopSharp_Young, AgabusPhilbert, AlexandraRicketts, AlfredLawley, AlmaHall, AltheaTwiddle, AnabelCalhoun, ArchieBickle, BettyBowditch, CassandraMason, CassiusWillardsey, CillianHawksworth, ClementineWillardsey, DaisyAbril, DorothyDencourt, ErnieLark, HansHoode, HelenThistlewood, HubertGray, HyacinthOlivier, IskoAbril, JasperTrout, JemimaCollins, JohannaBickle, LottieFeatherbottom, MarianneMoffett, NoraTreadwell, OttoDibble, PadraicHanks, PatrickRedding, PerditaStrix, PiersPemberton, RowlandOakes, RunoCalhoun, Sirona, SolomonSallow, ThaddeusTravers, WigotSpitchwick |
| Students | AdelaideOakes, AmitKakkar, AndrewLarson, AnneSallow, ArthurSiggs, AstoriaCrickett, BennyStokes, Bully1, Bully2, CharlotteMorrison, ConstanceDagworth, CressidaBlume, DuncanHobhouse, EricNorthcott, EvangelineBardsley, EverettClopton, FrancisDoyle, GarrethWeasley, GertrudeWigley, GraceWaldegrave, HectorWeasley, HerbertFleming, HildaLoddington, ImeldaReyes, LawrenceDavies, LeanderPrewett, LenoraAbbott, LucanBrattleby, MahendraKapoor, NatsaiOnai, NellieOggspire, NeridaRoberts, OminisGaunt, OwenWynn, PoppySweeting, PriscillaWakefield, SacharissaTugwood, SamanthaDale, SebastianSallow, SophroniaFranklin, VioletMcDowell, ZenobiaNoke |
| Professors | AbrahamRonen, AesopSharp, AesopSharpTeen, BaiHowin, ChiyoKogawa, CuthbertBinns, DinahHecat, EleazarFig, GeorgeOsric, MatildaWeasley, MirabelGarlick, MudiwaOnai, PhineasBlack, PhineasBlack_NoGloves_Look, SatyavatiShah |
| Prefects | GenericGryffindorPrefectBoy, GenericGryffindorPrefectGirl, GenericHufflepuffPrefectBoy, GenericHufflepuffPrefectGirl, GenericRavenclawPrefectBoy, GenericRavenclawPrefectGirl, GenericSlytherinPrefectBoy, GenericSlytherinPrefectGirl, HectorFawley |
| Staff and enforcers | AgnesScriven, GladwinMoon, NoreenBlainey, RuthSinger, T2AuthorityFemale1, T2AuthorityFemale2, T2AuthorityMale1, T2AuthorityMale2 |
| Other | AnneThisbe, CarriageDriver, IgnatiaFlooTravel, IsidoraBrother, IsidoraMorganachFather, NiamhFitzgerald, PensieveStudent, StudentVictim |

## Optional seats

An interaction can seat the player: a bench, a chair, a stool at a bar. Once its requirements,
progress and handler succeed, `seat` sits the player on a floor-level point through the client's
`LocalPlayer.anchor`, which holds them there inside the furniture where a teleport would shove them
clear. A seat with no `handler` only seats. Other players see the seated body where it is.

```ts
// A stock station bench at yaw 0, centred on a floor point. Its AnimStart socket, (-36, 56.3) cm in
// the mesh's own space, is the sit point; the sitter faces out along the mesh's +Y, the bench's yaw + 90.
const floor = { x: 1000, y: 2000, z: 300 };
Interact.register({
    id: "courtyard.bench.1",
    resource: "hmp-furniture",
    label: "Sit",
    position: floor,
    radius: 250,
    object: { model: "/Game/Gameplay/Stations/Bench/Props/SM_HM_Bench_A.SM_HM_Bench_A", yaw: 0 },
    seat: {
        position: { x: floor.x - 36, y: floor.y + 56.3, z: floor.z },
        yaw: 90,
        clip: "/Game/Animation/Human/Stations/Sitting/HUF_STN_SIT_Bench_Idle_EatingApple_ANM.HUF_STN_SIT_Bench_Idle_EatingApple_ANM",
        exit: { x: floor.x - 36, y: floor.y + 120, z: floor.z },
    },
});
```

- `position` is at **floor level**: on the game's station furniture, the mesh's `AnimStart` socket, in
  front of the seat, facing away from it; the seated `clip` carries the body back onto the seat. Use
  the station copy of a mesh (`/Game/Gameplay/Stations/...`); the environment copy has no sockets. For
  a bench turned by `yaw`, turn the socket offset with it and face `yaw + 90`.
- `clip` is an AnimSequence held on its last frame as the seated pose. Without one the player is held
  standing on the point.
- `exit` is where to stand up, at floor level, so a chair under a table lets them out clear of it;
  omitted, they stand up in place and the game pushes them out of whatever they overlap.
- One player per seat: another gets "Someone is already sitting there." The seat and exit must lie
  within `radius`, and a seat takes no `options`.
- While seated the prompt reads **Stand up** and F stands the player up. They also stand up when the
  interaction is unregistered, when they leave its virtual world or area, on `setEnabled(false)`, and
  when `hmp-interact` stops. Death, a kneel, mounting, a server hold or teleport, a fast travel and a
  map load end the seat on the host's side, and the seat is free again.

Seats need a HogwartsMP host with `LocalPlayer.anchor`. On an older host the interaction still runs
its handler, the player stays standing, and the seat is free again at once.

## Selection and concurrency

- The client scans every 100 ms and displays at most one `Hud.showPrompt`.
- Higher `priority` wins; equal priorities choose the nearest zone and then the stable ID.
- `promptDistance` is clamped to `radius`, so the prompt is never shown outside the legal range.
- `exclusive: true` permits only one player in the handler/progress flow at a time.
- A player can have only one active interaction flow at a time.
- Cooldowns are scoped to player + interaction + option and begin after successful execution.
- `setEnabled(false)` is available client-side for modes that temporarily suppress interaction UI.

## Security contract

The client sends only the displayed interaction ID. The server then:

1. resolves that ID from its own registry;
2. reads the server-owned player position and optional virtual world;
3. validates the activation radius;
4. validates the active character, groups, items and custom predicate;
5. offers only registered option IDs through `hmp-ui`;
6. repeats distance and requirements after menus and cancellable progress;
7. invokes the server-held handler function.

Client position, client-provided requirements, arbitrary event names and arbitrary handler payloads
are never accepted. Handler code remains responsible for making its own inventory/economy mutation
atomic when it changes multiple systems.

Interactions with `virtualWorld` are sent only to players currently in that world and are checked
again on activation. Call `Interact.sync(player)` after changing a player's virtual world so their
prompt snapshot updates immediately.

## Migrating the mod's `interactables` resource

The original mod resource proved the Framework substrate used here: `Key.bind`, `Hud.showPrompt`,
server `player.position`, and optional `WorldObject` props. Do not run both resources as global F-key
owners. Move each old placement into an `Interact.register(...)` call in its owning gameplay resource,
then disable the old `interactables` resource.

Foundations no longer binds F directly: `hmp-interact` registers it through `Hmp.input.shortcuts`.
Another Foundations mode can claim F at a higher priority while it is eligible; an equal-priority
collision refuses both actions and is visible in `Hmp.input.status()`.

True entity/raycast focus is intentionally not emulated. The current Framework exposes reliable
positions and replicated world objects, but not a general script raycast contract. A future provider
can extend selection without changing the server registration and validation API.
