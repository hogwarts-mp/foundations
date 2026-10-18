/**
 * quidditch — declarative config. Coordinates are world centimetres.
 *
 * The pitch numbers come from the game's own data, not from pacing it out: the POI
 * `HW_QuidditchPitch` in PhoenixGameData.sqlite, and the streaming tile that owns the pitch
 * collision. Both matter — see `envelope` below.
 */
module.exports = {
    version: 1,

    pitch: {
        // DEV_PointsOfInterest.HW_QuidditchPitch. Everything else is expressed relative to this.
        centre: { x: 323482.0, y: -465966.0, z: -85353.9 },

        // The POI is NOT the ground — it sits ~2 m above it. The level's own geometry clusters hard
        // at Z=-85550 within 60 m of centre, which is the deck, and that independently matches the
        // collision-plane height the streaming research landed on. Hoop heights are measured from
        // here, not from `centre`, so they mean what they say.
        deckOffset: -200,

        // The pitch geometry lives in the streamed tile HN_AZ_Quidditch, whose box is roughly
        // 516 x 588 m horizontally but only ~60 m tall above the POI. Leaving it does not just
        // unload scenery — the floor's collision unregisters on *hide*, before unload. Keep play
        // inside this and a dropped ball still has something to land on.
        envelope: { xy: 25000, up: 5500, down: 1500 },

        // drawDistance (cm) for every pitch object: banners, hoops, bludgers, quaffle and snitch.
        // 0 never culls, so a ball is visible from anywhere it streams to (500 m), across the whole
        // pitch and stands. Small props otherwise vanish past ~15-20 m.
        propDrawDistance: 0,

        // cm ABOVE THE DECK that a player is placed at kickoff. Zero, because there is no way to
        // put someone on a broom from script: the local mount runs through ABroomItemTool ->
        // AFlyingBroom.PlayerMountAbility and nothing we expose reaches it. Spawning in the air
        // therefore means falling, and an eleven-metre drop onto the deck is how it used to start.
        // Standing on the pitch and kicking off is also what a real match looks like.
        //
        // Raise this once mounting is drivable, not before.
        spawnHeight: 60,

        // Nearest fast travel is M_FT_BRR_01 at ~55 m; FT_HW_FlyingClass at ~196 m is the safer
        // public one because BRR_01's is a race pad.
        fastTravel: "FT_HW_FlyingClass",

        // Hoop placement is derived, not hand-typed. Measured from the level itself
        // (HN_AZ_Quidditch, 338 structure points): the pitch's long axis runs 82.8 deg from +X —
        // i.e. essentially along +Y — and the structure spans 189 m along it by 112 m across. The
        // level's bounding-box centre lands within 15 m of the POI above, so `centre` is the field
        // centre. Stands are included in those spans, so the playable field is smaller.
        hoopGeometry: {
            axisDeg: 82.8,        // long axis of the pitch, degrees from +X
            goalDistance: 5000,   // cm from centre to each goal line, ALONG the axis
            spacing: 1100,        // cm between adjacent hoops, ACROSS the axis
            // cm ABOVE THE DECK, in lateral order: left, centre, right. Symmetric, centre tallest.
            // The hoops are not in the level, so unlike everything else here these were not measured
            // — they were flown and eyeballed in game, which is why they sit much higher than the
            // first guess at them.
            heights: [2150, 3000, 2150],
            // Ring yaw = axisDeg + this. A race ring's aperture faces its forward (local +X), and
            // a hoop must be flown/shot THROUGH along the pitch's length. If the rings end up
            // side-on, the ring's aperture is perpendicular to its forward — add 90 here.
            yawOffset: 0,
        },

        // Whose end is whose, readable from the air. A player mid-flight should not have to work out
        // which triple of hoops is theirs by dead reckoning off the pitch axis — the banner says it.
        goalBanners: {
            gryffindor: "/Game/Environment/Hogwarts/Meshes/Props/SM_HW_Banner_Gryf_A.SM_HW_Banner_Gryf_A",
            slytherin:  "/Game/Environment/Hogwarts/Meshes/Props/SM_HW_Banner_Sly_A.SM_HW_Banner_Sly_A",
            hufflepuff: "/Game/Environment/Hogwarts/Meshes/Props/SM_HW_Banner_Huff_A.SM_HW_Banner_Huff_A",
            ravenclaw:  "/Game/Environment/Hogwarts/Meshes/Props/SM_HW_Banner_Rav_A.SM_HW_Banner_Rav_A",
        },
        // ABOVE the goal, not behind it. Two measured facts decide this:
        //
        //  - the mesh HANGS DOWN from its pivot (ExtendedBounds origin Z -284, extent 312, so it
        //    reaches ~600 units below and only ~28 above), so the spawn point is the top of the
        //    banner, not its middle;
        //  - pushing it 9 m past the goal line put it inside the stands, where it rendered perfectly
        //    and was seen by nobody.
        //
        // So: hang it from high enough that its bottom clears the tallest hoop.
        // Offsets in the BANNER's own frame: `fwd` runs down the pitch, `side` is its own right.
        // Both mirror at the far end, so one pair of numbers places the banner at both goals.
        bannerFwd: 0,
        bannerSide: -225,
        bannerLift: 550,        // gap between the banner's bottom edge and the top hoop
        bannerDropUnits: 600,   // how far the mesh falls below its own pivot, unscaled — measured
        bannerScale: 3,
        // A banner is a flat plane, so its face is a quarter turn off the axis it hangs along.
        // WHICH quarter was measured by spawning all four side by side and seeing which faced
        // back. It read 90 when the big banner took its yaw from the pitch axis; both sizes now
        // take the ring's own facing plus the per-end flip, and against that basis it is 270.
        bannerYawOffset: 270,

        // A smaller banner under every ring, not just the big one over the goal. Three narrow
        // pennants under three hoops reads as ownership at a glance from any angle, where one large
        // banner only reads from in front of the centre.
        //
        // Sized to hang clear: a ring aperture is 383 across and the mesh is ~180 wide unscaled, so
        // 1.5 keeps it inside the ring's width. The drop is measured from the ring down, and the
        // lowest hoop sits 2150 above the deck — enough for a 900-long hang plus the gap.
        bannerPerHoop: true,
        bannerHoopScale: 1.5,
        bannerHoopGap: 480,
        // The ring banners carry their own yaw and offsets. They hang under a ring rather than
        // over the goal, so nothing says they want the big one's numbers.
        bannerHoopYaw: 270,
        bannerHoopSide: 10,
        bannerHoopFwd: 0,

        // A hoop is a race ring, and a race ring carries three hidden BlockAll pillars ~11 m below
        // its aperture. Anything below this height above the deck puts an invisible wall on the pitch.
        hoopMinHeight: 1300,
    },

    ball: {
        mesh: "/Game/Gameplay/Nurturing/Creatures/Meshes/Toys/SM_Sanc_BeastToy_QuidditchQuaffle.SM_Sanc_BeastToy_QuidditchQuaffle",
        massKg: 2.0,
        // How close you must be for "Take Quaffle" to be offered — a server distance check, since
        // the simulating body ignores Pawn and so cannot see brooms. Not a ~1 m reach: that is
        // nothing at all on a broom, which crosses it inside one tick before the offer appears.
        //
        // Sized against SPEED, not against arm's length. A broom covers ~20 m/s, so even with the
        // context poke refreshing the offer at ~6 Hz you move ~3 m between rebuilds; at 7 m the
        // window was under half a second and the press landed after it closed. 12 m is about a
        // second of approach, which is what makes it pressable rather than lucky.
        // Who may take possession. A Chaser's job is the quaffle, and the Keeper handles it too --
        // canon has them gathering it to put it back in play, and a Keeper who could clear a shot
        // but never pick the ball up was left with nothing to do with a save.
        //
        // Carrying is the whole permission: throwing, passing and shooting all gate on BEING the
        // carrier rather than on a role, so this one list decides who can do any of it. A Seeker
        // who happens to fly past should not end up carrying the match. Empty or absent = anyone.
        carryRoles: ["chaser", "keeper"],
        pickupRadius: 1200,
        // The only socket on this skeleton proven to exist — the wand rides it. A name that does not
        // exist does not error: the engine attaches at the mesh origin instead, silently.
        carrySocket: "WandSocket",

        // Keys for the carry actions. Both aim along the camera, so they have to be a single press —
        // opening a radial menu to shoot means letting go of the mouse, which IS the aim. rp-ui binds
        // these only while the action is legal, so they cost nothing when you are not carrying.
        // `f` is contested by five other resources and `i`/`e` are taken; q and r are free.
        passKey: "q",
        shootKey: "r",

        // Above ~4500 a 20 Hz segment test starts to matter; above ~5000 physics itself gets
        // unreliable, since this build has no sub-stepping (MaxPhysicsDeltaTime 0.0333).
        throwSpeed: 3000,
        throwSpeedMax: 4500,
        gravity: 980,
    },

    snitch: {
        // Seeker airspace, relative to centre. Kept well inside `envelope`.
        volume: { xy: 9000, minZ: 800, maxZ: 4800 },
        // The shipped BP flies itself and is client-local + random-driven, so the server owns the
        // authoritative point and clients run the actor as a puppet.
        // A leg is a short hop in a mostly-continuous direction, NOT a jump to a random point in
        // the volume — that reads as teleporting and cannot be chased. Distance per leg is
        // speed * legSeconds, so these three numbers are what make it feel like a pursuit.
        // The BP's OWN timeline play-rate (its default is 3.0), scaled by fatigue every steer beat.
        // Without this only the container box slows down and the snitch keeps flying full-speed arcs
        // around a stationary point — the box says WHERE it roams, this says HOW FAST it flies.
        // Never quite 0: a stalled timeline may not fire the callback that starts the next state.
        // A leg is a LERP over a 1 s timeline, so its duration is 1/rate no matter how far it has to
        // go. That makes the floor load-bearing: at 0.05 a stranded mesh took ~20 s to reach its box
        // and freeze/"bring to me" could not recover it, so the snitch you saw and the snitch being
        // tested ended up tens of metres apart. At 1.0 a leg always lands within a second.
        bpSpeed: 3.0,
        bpSpeedMin: 1.0,

        // How FAR a Swoop may carry it: the steering container's box extent in cm, scaled by fatigue.
        // This is the one that actually stops an exhausted snitch. bpSpeed alone only slows the
        // timeline, so a tired snitch flew the same long leg slowly and still crossed the pitch.
        // Flit and Vibrate roam boxes attached to the snitch itself, so it always keeps a small
        // local flutter — which is what an exhausted snitch should look like anyway.
        roam: 3000,
        roamMin: 60,

        legSeconds: 1.8,
        cruiseSpeed: 1100,      // cm/s when nobody is close
        fleeSpeed: 2100,        // cm/s once a seeker is inside fleeRadius
        momentum: 0.7,          // how much of the previous heading carries into the next leg
        wander: 0.55,           // random turn mixed in per leg
        fleeRadius: 2200,
        fleeStrength: 0.9,      // weight of the away-from-seeker term when fleeing
        // Caught by FLYING CLOSE AND STAYING THERE — not by Accio, not by collision. The radius no
        // longer has to absorb puppet-vs-server drift (the catch tests the position the client
        // reports for its own actor), so it can be tight enough that staying on the snitch is the
        // skill rather than being roughly near it.
        // Who may take the snitch. The `snitchHunt` mode ignores this on purpose -- everyone
        // hunting is the whole game there. Empty or absent = anyone.
        catchRoles: ["seeker"],
        catchRadius: 600,
        steerMs: 200,      // how often the simulator's steering box is re-aimed at the live point
        catchHoldMs: 2000,
        feintChance: 0.18,
        feintHideMs: 3000,
        points: 150,

        // A snitch that never tires is a stalemate — it can always outrun you, so the hunt only ends
        // when the match clock does. It wears down instead: after `graceSec` its speed and evasion
        // decay toward `floor`, and the catch window widens, so the chase always converges.
        // Fully tired at graceSec + rampSec. `floor` is how tired, not how soon.
        // Seconds after kickoff before the snitch is let out. Canon releases it after a delay, and
        // the practical reason is the same: with it on the pitch from the first second a 15-minute
        // match can be over in ninety seconds, and everything else on the pitch never happens.
        //
        // The fatigue clock below starts at RELEASE, not at kickoff. Timing it from kickoff would
        // spend the grace period while the snitch was still in the box.
        //
        // 0 releases it immediately. Snitch Hunt sets that on the mode, because there the snitch is
        // the entire game.
        releaseAfterSec: 300,

        fatigue: {
            graceSec: 45,      // full strength for this long, nothing changes
            rampSec: 180,      // then it slows over this many seconds
            // 0 = it stops dead when fully spent, which is the strongest version of "the chase always
            // converges": there is a moment where the snitch is simply there to be taken. Raise it if
            // an exhausted snitch reads as broken rather than beaten.
            floor: 0,
            radiusBonus: 700,  // extra catch radius once fully tired (cm)
        },

        // No world label: the Niagara comet trail tracks it well enough by eye, and the label was
        // competing with the single world-prompt slot for no benefit.

        // Minimap blip OFF by default. A seeker with a blip plays the minimap instead of the sky,
        // which is the opposite of the point — the trail exists so the snitch can be found by eye.
        // Toggleable live from the manager, since whether the hunt is fair without it is a feel
        // question and not one to settle from a config file.
        blip: false,
        // The shipped snitch prop is only a few centimetres across. Scale it until it reads against
        // sky; 1 is the authentic size and is genuinely hard to spot.
        scale: 4.0,
        // On/off only — the Niagara spawn signature has no Scale parameter. NOT the game's own
        // VFX_P_SnitchWingTrail: that is a Cascade AnimTrail needing two skeletal sockets via
        // BeginTrails, unreachable through SpawnEmitterAttached, and a 14 cm wing blur regardless.
        trailScale: 1,
        // Niagara with no EffectType, so nothing distance-culls it.
        trail: "/Game/VFX/Niagara/Interactables/VFX_NS_FlyingSparkleComet_Trail.VFX_NS_FlyingSparkleComet_Trail",
        hudRange: 100,     // metres over which the proximity bar closes
    },

    bludgers: {
        // Bludgers are SERVER-simulated WorldObjects: the server moves them and every client in
        // range interpolates. They used to be gated to `match` (2 players minimum), so they had never actually been
        // seen in play; the count is the switch now and /quidditch bludgers <n> overrides it live.
        count: 2,
        // ON during bring-up. The purist argument is the snitch's — a thing you track on the minimap
        // is a thing you never look up at — but that only holds once you can reliably SEE the thing,
        // and a bludger that hits you from off-screen with no marker is just a mystery. Turn this off
        // once the mesh and its trail read well in the air.
        blip: true,
        // Bludgers WIND UP rather than cruising. A constant-speed homer is either always too fast to
        // dodge or always too slow to fear; ramping from speedMin toward speedMax gives it a menace
        // that builds, and every hit or bat drops it back to speedMin so the threat has to rebuild.
        speedMin: 750,
        speedMax: 2200,
        accel: 500,          // cm/s^2
        // The shipped bludger mesh is small for something meant to be seen coming at speed.
        scale: 4.0,
        // The REAL Quidditch bludger. BP_BludgerBallToy spawns happily and draws nothing (a
        // Vivarium toy is dressed when a beast picks it up). Its skeleton, Beater/SK_Quidditch, is
        // the BLUDGER rig, not a bat: VFX_Impact, VFX_Trail_Base_Socket and VFX_Dust_Socket.
        mesh: "/Game/RiggedObjects/Props/Quidditch/Bludger/SK_Quid_Bludger.SK_Quid_Bludger",
        // The game's own bludger trail, from the "Don't Snitch" world event.
        trail: "/Game/VFX/World_Events/WOW/WOW_DontSnitch/VFX_NS_BludgerTrail.VFX_NS_BludgerTrail",
        trailSocket: "VFX_Trail_Base_Socket",
        homingStrength: 0.35,
        hitRadius: 80,
        // A hit is a knock, not damage: a partial-body reaction that cannot dismount, plus a short
        // input lock. Nothing here touches health or the save.
        // How long input is taken. Short on purpose: a bludger should stagger you, not bench you.
        stunMs: 5000,
        // How long you cannot be hit again — a SEPARATE and much longer window. These used to be one
        // number, so immunity expired the moment control returned and two bludgers could chain you
        // almost continuously: stunned 1.8 s out of every 4, which is indistinguishable from stuck.
        hitImmuneMs: 15000,
        // Back ON, with a watchdog behind it. The override stack is weak-instigator-keyed and NOT
        // refcounted: our (Debug, null) push is one entry and a single Finish clears it, so the only
        // way to stay locked is for that Finish never to be called. The client pops every 2 s while
        // it believes it should not be stunned, which bounds the worst case at a couple of seconds
        // instead of the rest of the session. /quidditch unstick is still the manual way out.
        stunDisablesInput: true,
        // After a hit it leaves, instead of steering straight back. Without this it orbits whoever it
        // just hit at full speed for the whole stun window, landing no further hits and reading as a
        // glitch rather than a bludger.
        retreatMs: 1500,
        retreatSpeed: 1800,
        reactionAbility: "/Game/Pawn/Student/Abilities/PartialBody/Broom/ABL_HoverBroom_Hitch_Frnt.ABL_HoverBroom_Hitch_Frnt_C",
        reactionChannel: "PartialBody",
        // Both Quidditch-usable abilities carry m_Length = +inf and park on their channel forever;
        // the Behaviour Tree normally ends them and a relayed play has no BT.
        reactionCancelMs: 1200,

        // --- the beater swing ---
        // AFlyingBroom declares SwingBeaterAbility and BeaterMeshComponent, but those ability assets
        // were STRIPPED from the shipped game, and there is no player-skeleton swing anywhere in it.
        // The creature swings (Troll, MerlinGrunt) are the wrong rig entirely. This conjuring swipe is
        // a lateral arm sweep on the player, partial-body, and reads as a bat swing.
        swingAbility: "/Game/Pawn/Student/Abilities/PartialBody/Conjuring/ABL_ConjuringObject_SwipeRight.ABL_ConjuringObject_SwipeRight_C",
        swingChannel: "PartialBody",
        swingCancelMs: 900,
        swingKey: "v",          // e/q/r are taken by take/pass/shoot, f is contested by five resources
        // Beaters bat. Everyone used to be able to, on the grounds that a chaser defending itself
        // performs the same motion -- but that made the Beater a costume rather than a position.
        // Empty or absent = anyone.
        swingRoles: ["beater"],
        swingRadius: 1400,      // how close a bludger must be to swing at, cm
        swingSpeed: 2600,       // cm/s the bludger leaves at, along your aim
        swingImmuneMs: 1200,    // it cannot hit the person who just hit it
        swingCooldownMs: 700,
        swingHit: "bludger_hit_Play",

        // Purely cosmetic. Canon Quidditch has ONE beater bat — a short wooden club, the same for
        // both Beaters on a side — and no variant carries a role or a stat. Equipment that actually
        // differs in the books is the BROOM, which is where per-role tuning belongs (see Q6).
        // Every bat the game ships, pickable live from the manager — the three static ones are shop
        // and station dressing, the rigged one is the only asset in a folder actually named Beater.
        // equipProp reads the asset to decide StaticMeshActor vs SkeletalMeshActor, so kind is not
        // something this list has to declare.
        bats: [
            { id: "heavy",  label: "Station",  mesh: "/Game/Gameplay/Stations/ChildProps/Hogwarts/Quidditch/SM_HM_Quid_HeavyBat.SM_HM_Quid_HeavyBat" },
            { id: "shopA",  label: "Shop A",   mesh: "/Game/Environment/Hogsmeade/Common/Meshes/MiscProps/SM_HM_BeatersBat_A.SM_HM_BeatersBat_A" },
            { id: "shopB",  label: "Shop B",   mesh: "/Game/Environment/Hogsmeade/Common/Meshes/MiscProps/SM_HM_BeatersBat_B.SM_HM_BeatersBat_B" },
            { id: "shopC",  label: "Shop C",   mesh: "/Game/Environment/Hogsmeade/Common/Meshes/MiscProps/SM_HM_BeatersBat_C.SM_HM_BeatersBat_C" },
        // NOT here: RiggedObjects/Props/Quidditch/Beater/SK_Quidditch. It looks like the beater bat
        // and is not a mesh at all — it is a **Skeleton** asset (8 sockets: VFX_Impact,
        // VFX_Trail_Base_Socket, VFX_Dust_Socket…, plus a Skeleton export). The rig shipped; the mesh
        // it posed did not, so there is nothing to display and both mesh loads fail.
        ],
        bat: "heavy",           // which of the above a beater starts with
        batSocket: "WandSocket",  // the only socket on this skeleton we have proof exists
        // Relative to the socket. WandSocket is authored for a short wand, so a long bat will almost
        // certainly need nudging — these are live from the manager rather than a rebuild per guess.
        // Pitch 90 found by eye in game. The station bat's collision hull runs X from -8 to +57 cm,
        // i.e. it lies along its own +X with the grip at the origin — and WandSocket is authored to
        // point a short wand forward, so the bat needs standing up out of that axis.
        batOffset: { pitch: 90, yaw: 0, roll: 0, x: 0, y: 0, z: 0, scale: 1 },
    },

    scoring: {
        goal: 10,
        // Goals are a segment-vs-plane crossing on positions the server already owns. A naive point
        // test at 20 Hz silently drops goals above 3540 cm/s; the segment test errs by ~0.3 cm.
        tickHz: 20,
        hoopRadius: 383,
        matchSeconds: 900,

        // The post-match window. The session does NOT end the instant the snitch is caught: the
        // pitch stays up, scoring stops, the banner plays and the results panel reads out. Ending in
        // the same tick that announced the catch meant the banner and the teardown raced each other.
        celebrateMs: 14000,
    },

    /**
     * Wwise event names. The game ships Quidditch audio despite the sport being cut — the goal and
     * victory stingers belong to a decorative Room-of-Requirement Quidditch table, and the stadium
     * ambience to the pitch itself. A sound is just a string: the asset name under
     * `/Game/WWise/Events/` IS the event name, and a post whose bank is not resident loads that bank
     * and retries by itself, so nothing here needs the pitch to be streamed in first.
     *
     * Set any of these to "" to silence it.
     */
    sounds: {
        // A crowd under a firework, on both moments — the crowd sells who it was for, the firework
        // sells how big it was. The Quidditch-branded stingers are NOT used: they are inaudible even
        // played straight to yourself with /sfxme, being authored for a small Room-of-Requirement
        // table ornament rather than a stadium. The `_2D` crowd variants are unpositioned and so play
        // at full level wherever on the pitch the goal happened.
        goalCheer: "small_crowd_big_cheer_2D",       // heard by the scoring side
        goalGroan: "small_crowd_dissapointed_2D",    // heard by everyone else (asset name is misspelled)
        goalNeutral: "small_crowd_lowkey_cheer_Play", // nobody's goal — solo play, or no known scorer
        // The lighter volley for a goal; the fuller end-gate below for the thing that ends the match.
        goalSting: "BRR_Fireworks_All_Play",
        // The moment the match turns: a crowd reacting to something being let out of a box.
        snitchRelease: "small_crowd_big_cheer_2D",
        victory: "small_crowd_big_cheer_2D",
        // What `BP_RaceEndGate_C` posts as you cross a race finish, so it already reads as an ending.
        // Fired whenever a session is DECIDED — the snitch or the clock.
        finish: "BRR_Fireworks_EndGate_Play",
        // Spatialized at the ball, so a pass you did not see still reads as a pass.
        catch: "TransfigObs_BeastToybox_ToyBounce_QuidditchQuaffle_Play",
        // 2D stadium beds, started on setup and stopped on teardown. Both are loops, so they are the
        // one thing here that MUST be stopped — see the id bookkeeping in the server script.
        ambienceField: "Amb2D_Overland_QuidditchStadium_Field_Play",
        ambienceStands: "Amb2D_Overland_QuidditchStadium_Stands_Play",
    },

    /**
     * The keeper, and the scoring area.
     *
     * A chaser flying the quaffle straight through a hoop leaves nothing to defend. The fix is NOT a
     * minimum shot distance — neither canon Quidditch nor real quadball has one. The actual rule is
     * that the carrier may not take the ball through the hoop themselves (canon calls the family of
     * fouls around this Haversacking), and that defenders may put hands on a carrier in the scoring
     * area. So: carrying it through scores nothing, and a keeper can tackle a carrier who tries.
     */
    keeper: {
        // Around each hoop. Inside it a carrier is tackleable, which is what makes camping the hoop
        // a risk rather than a free goal.
        scoringArea: 2600,

        // A save: deflect a loose ball along the aim. A clearing kick, not a catch.
        // The Keeper's punch-clear. A Chaser standing in the same place has the better option
        // already -- pickup reaches 1200 to this 1000, so the ball they could INTERCEPT was also
        // offered to them as something to swat away, and only one of those two is ever what a
        // Chaser wants. Empty or absent = anyone.
        blockRoles: ["keeper"],
        blockRadius: 1000,
        blockSpeed: 2400,
        blockKey: "b",
        blockCooldownMs: 800,
        blockSound: "bludger_hit_Play",

        // The tackle. Only against a carrier, only inside the scoring area.
        tackleKey: "t",
        // The Keeper's own answer to a chaser sitting on the hoops. Same shape as ball.carryRoles
        // and bludgers.swingRoles: empty or absent = anyone.
        tackleRoles: ["keeper"],
        tackleRadius: 700,
        tackleCooldownMs: 2000,
        // The lasting part. Losing the ball is a moment; being unable to take it back is a
        // consequence — it forces the attack to reset and rotate rather than the same chaser
        // immediately re-grabbing and trying the identical thing.
        fumbleMs: 12000,
        tackleStunMs: 700,

        // NOT canon and off by default. Kept because it is one number and it is the bluntest way to
        // force shots to have flight time, if the tackle turns out not to be deterrent enough.
        minShotDistance: 0,
    },
    /**
     * The lobby a referee calls before a match.
     *
     * A match needs sides and positions agreed BEFORE it starts, and the old path just swept up
     * whoever happened to be connected and assigned roles round-robin — which is fine for testing
     * alone and meaningless with people. Here a referee calls it, everyone picks an open slot on
     * either side, and the referee starts when the teams look right rather than when a clock says so.
     */
    lobby: {
        // How long a seat is held for someone who dropped out of a running match. Long enough to
        // relaunch the game after a crash; short enough that a slot is not held all match by
        // somebody who left for good.
        rejoinSeconds: 300,

        // The join window. It is a default, not a rule: the referee can start early at any point,
        // and a full lineup does not have to wait out the clock.
        joinSeconds: 120,
        // Both sides are visible to everyone. Seeing the other team fill up is most of what makes a
        // lobby feel like a fixture rather than a form.
        teams: ["gryffindor", "slytherin"],
        // Canon lineup: three chasers, two beaters, a keeper and a seeker. Seven a side.
        lineup: { chaser: 3, beater: 2, keeper: 1, seeker: 1 },
        // Below this the referee gets a warning rather than a refusal — a four-a-side scratch match
        // is still a match, and refusing to start one helps nobody.
        wantPerTeam: 2,
        // A call shows eligible players a small card on the right and nothing else; this key opens the
        // position picker for those who want in.
        joinKey: "j",
        // How often the panel re-reads the roster. Cheap: rp-ui does not re-send a tree that
        // serialises to what the client already holds, so a lobby where nothing moved costs nothing.
        refreshMs: 900,
        panelId: "quidditch:lobby",
    },

    // Crest colours, sent to the overlays rather than duplicated inside each of them. The values
    // match banner.html's own map, which still carries a copy for its text variants -- folding
    // that one in here as well is on the list.
    houseColours: {
        gryffindor: "#c0392b",
        slytherin: "#2f8f5b",
        hufflepuff: "#e8b62c",
        ravenclaw: "#4a6cc4",
    },

    roles: ["chaser", "beater", "keeper", "seeker"],

    // Who may call, start, stop and tune a match (the manager, /quidditch call|start|stop|...).
    // "staff" means holders of the hmp-core `group` at `minimumGrade` or above; "anyone" opens it to
    // every player. Seats, teams and positions are never gated.
    control: {
        who: "staff",
        group: "admin",
        minimumGrade: 1,
        // With nobody online who qualifies, let anyone run a match rather than leave the pitch locked.
        anyoneWhenNoStaff: true,
    },

    modes: {
        // Each is playable alone, and each is a real mode: `keeperDuel` used to sit here as a
        // label with no logic of any kind behind it -- Full Match under another name -- and
        // `hoopCircuit` promised a timed circuit it never had.
        //
        // `minPlayers` is the only key here that is read. Anything else added to a mode has to be
        // wired to something, or it is decoration that reads as a feature.
        // `releaseAfterSec` overrides snitch.releaseAfterSec: waiting five minutes for the only
        // thing in the mode would be a strange game.
        snitchHunt: { label: "Snitch Hunt", minPlayers: 1, releaseAfterSec: 0 },
        // A quiet pitch: hoops and a quaffle, no bludgers and no snitch. Named for what it is,
        // which is where you test anything to do with the hoops without something chasing you.
        practice: { label: "Practice", minPlayers: 1 },
        match: { label: "Full Match", minPlayers: 2 },
    },

    // Casting while broom-mounted is off in the stock game (only Revelio). Every spell-based mode
    // needs this; it is a per-client GameLogic BoolVar, not a save write.
    unlockMountedCasting: true,

    // The pitch has NoMount volumes and a region flight ceiling. Both are lifted per-client for the
    // duration of a match and restored after.
    liftFlightLimits: true,

    broomItem: "BroomHouse",
};
