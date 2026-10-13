/**
 * quidditch resource — server script (the authority).
 *
 * Everything that decides an outcome lives here and runs off `player.position`, which the server
 * owns: goal crossings, snitch catches, bludger hits and possession. The client is a renderer and a
 * trigger source; it is never trusted with a result.
 *
 * Three facts from the RE shape this file and are worth knowing before editing it:
 *
 *  - A goal is a SEGMENT-vs-plane test, not a point test and not a trigger volume. The hoop's own
 *    aperture only overlaps Pawns (so it can register a player flying through, never the ball), and
 *    a naive point sample at 20 Hz silently drops goals above ~3540 cm/s.
 *  - There is NO possession arbitration in the game. Two casters can hold the same object and both
 *    apply impulses, so the lock below is mandatory rather than belt-and-braces.
 *  - The snitch actor is client-local and random-driven, so two clients would otherwise see two
 *    different snitches. The server owns the point; clients run the actor as a puppet.
 *
 * Public testing commands:
 *   /quidditch                 show state
 *   /quidditch ball            drop ONE quaffle in front of you, no session (the Accio probe)
 *   /quidditch ballclear       remove it
 *   /quidditch cast [on|off]   unlock casting while broom-mounted, with no session running
 *   /quidditch hoops [dist] [axisDeg] [spacing] [yawOffset]   re-place the hoops live
 *   /quidditch hoopheight <outer> [centre]   set hoop heights in cm above the deck
 *   /quidditch trail <scale>   respawn the snitch with a different trail scale
 *   /quidditch open            open the lobby panel
 *   /quidditch start <mode>    start a mode (snitchHunt | practice | match)
 *   /quidditch stop            end the session
 *   /quidditch team <house>    pick a side before kickoff
 *   /quidditch role <role>     pick a position (chaser | beater | keeper | seeker); live mid-match
 *   /quidditch join            open the position picker, or take a seat in a running match
 *   /quidditch pitch           teleport to the pitch, with a broom if you have not got one
 */

const RESOURCE = "hmp-quidditch";
const Hmp = Imports.get("hmp-lib");
const Core = Imports.get("hmp-core");
const Activities = Imports.get("hmp-activities");
const Ui = Imports.get("hmp-ui");
const Houses = Imports.get("hmp-houses");
const Inventory = Imports.get("hmp-inventory");
const Interact = Imports.get("hmp-interact");
const FoundationAudio = Imports.get("hmp-audio");
const FoundationBlips = Imports.get("hmp-blips");
const FoundationWorld = Imports.get("hmp-world");
const logger = Hmp.logger.create(RESOURCE);
const AUDIO_OWNER = { resource: RESOURCE, id: "match" };

logger.info("Server loading");

const CONFIG = require("../quidditch.config.js");

// Subcommands that start, stop, retune or re-place the match. The rest (state, team, role, join,
// pitch, results, why, ballwhere) are the documented player surface and stay open.
const MANAGE_SUBS = new Set([
    "call", "cancel", "start", "stop", "open", "manager", "ball", "ballclear",
    "bannertest", "banner", "bat", "bludgers", "trail", "hoopheight", "hoops", "cast",
]);

/**
 * Who may call, start, stop and tune a match, per `control` in quidditch.config.js: holders of an
 * hmp-core group at or above a grade, or anyone. With `anyoneWhenNoStaff`, a pitch with no qualifying
 * player online opens up to everyone rather than sitting locked until an admin logs in.
 */
async function canManage(player) {
    const control = CONFIG.control || {};
    if (control.who === "anyone") return true;
    const group = control.group || "admin";
    const grade = control.minimumGrade ?? 1;
    const qualifies = async (p) => {
        try { return await Core.groups.has(p, group, grade); }
        catch (_) { return false; }
    };
    if (await qualifies(player)) return true;
    if (control.anyoneWhenNoStaff === false) return false;
    const others = PlayerManager.getAll().filter((p) => p.id !== player.id);
    return !(await Promise.all(others.map(qualifies))).some(Boolean);
}

async function requireManager(player) {
    if (await canManage(player)) return true;
    const control = CONFIG.control || {};
    const grade = control.minimumGrade ?? 1;
    const text = `Managing a match needs the ${control.group || "admin"} group${grade > 1 ? ` at grade ${grade}` : ""}.`;
    try { player.sendChat(text); } catch (_) {}
    try { Ui.notify(player, { title: "Quidditch", description: text, tone: "warning" }); } catch (_) {}
    return false;
}

const P = CONFIG.pitch;
const CENTRE = P.centre;
const DECK_Z = CENTRE.z + (P.deckOffset || 0);
const TICK_MS = Math.max(20, Math.floor(1000 / (CONFIG.scoring.tickHz || 20)));

const HOUSES = ["gryffindor", "slytherin", "hufflepuff", "ravenclaw"];
const ACTIVITY_ID = "quidditch";
const unregisterActivity = Activities.definitions.register({
    id: ACTIVITY_ID,
    resource: RESOURCE,
    label: "Quidditch",
    description: "A match, practice session, or Snitch hunt on the Hogwarts pitch.",
    minimumPlayers: 1,
    maximumPlayers: 15,
    requireReady: false,
    requiresCharacter: true,
    exclusive: true,
    disconnectPolicy: "remove",
    defaultVisibility: "public",
    scope: "areaAndVirtualWorld",
    lobbyTtlSeconds: (CONFIG.lobby && CONFIG.lobby.joinSeconds) || 120,
});

/**
 * The character's actual house. `player.house` is a server-side property maintained by the `house`
 * resource, which writes through to the native `UIManager::SetPlayerHouseEnum` path — so this is the
 * house the player is wearing robes for, not a guess.
 *
 * Returns null for "Unaffiliated" or anything unreadable, and the caller falls back.
 */
function playerHouse(player) {
    try {
        const h = String(player.house || "").toLowerCase();
        return HOUSES.includes(h) ? h : null;
    }
    catch (_) { return null; }
}

// ---------------------------------------------------------------- geometry

const v = (x, y, z) => ({ x, y, z });
const add = (a, b) => v(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => v(a.x - b.x, a.y - b.y, a.z - b.z);
const scale = (a, k) => v(a.x * k, a.y * k, a.z * k);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a) => Math.sqrt(dot(a, a));
const norm = (a) => { const l = len(a) || 1; return scale(a, 1 / l); };
const dist = (a, b) => len(sub(a, b));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Build the six hoops from the pitch's measured long axis. The goal-plane normal is the axis
 * itself, pointing back toward the centre, which is what the segment test crosses.
 */
// Live override for how many bludgers a session starts with; null = whatever the config says.
let bludgerCount = null;

// Live overrides for the goal banners. Same idea as TUNE for the hoops: the panel and the config
// merge into one set, so tuning one number does not discard another.
let BTUNE = {};
const bcfg = () => {
    // One key at a time with its own fallback. Object.assign over a bag of `P.banner*` lookups
    // writes `undefined` for any key the config does not carry, and an undefined REPLACES the
    // default beneath it rather than falling back to it -- so adding a slider whose key was not
    // in the config zeroed the very value it was meant to expose.
    const from = (key, dflt) => {
        const val = P[key];
        return typeof val === "number" || typeof val === "boolean" ? val : dflt;
    };
    return Object.assign({
        yaw: from("bannerYawOffset", 0),
        lift: from("bannerLift", 250),
        scale: from("bannerScale", 3),
        side: from("bannerSide", 0),
        fwd: from("bannerFwd", 0),
        hoopYaw: from("bannerHoopYaw", from("bannerYawOffset", 0)),
        hoopGap: from("bannerHoopGap", 220),
        hoopScale: from("bannerHoopScale", 1.5),
        hoopSide: from("bannerHoopSide", 0),
        hoopFwd: from("bannerHoopFwd", 0),
        perHoop: from("bannerPerHoop", true),
    }, BTUNE);
};

let TUNE = {};   // live overrides on hoopGeometry; every tuning surface merges into this

function buildHoops(over) {
    if (over) Object.assign(TUNE, over);
    const g = Object.assign({}, P.hoopGeometry, TUNE);
    const a = (g.axisDeg * Math.PI) / 180;
    const along = v(Math.cos(a), Math.sin(a), 0);          // pitch length
    const across = v(-Math.sin(a), Math.cos(a), 0);        // pitch width
    const out = [];
    for (const end of [1, -1]) {
        g.heights.forEach((h, i) => {
            const lateral = (i - (g.heights.length - 1) / 2) * g.spacing;
            const height = Math.max(h, P.hoopMinHeight);
            const flat = add(add(CENTRE, scale(along, end * g.goalDistance)), scale(across, lateral));
            const pos = v(flat.x, flat.y, DECK_Z + height);
            // The ring must FACE down the pitch, not sit square to the world. UE yaw is degrees
            // from +X toward +Y, which is the same convention axisDeg is measured in.
            // `end` is which half the hoop stands in. A goal is only a goal at the end you are
            // ATTACKING, so the sides have to be distinguishable before anyone can score wrongly.
            out.push({ pos, end, normal: scale(along, -end), yaw: g.axisDeg + (g.yawOffset || 0) });
        });
    }
    return out;
}
let HOOPS = buildHoops();

/**
 * A house banner over each goal, so a player in the air can see whose end they are at.
 *
 * Only meaningful when two sides actually defend ends — in a free-for-all every hoop is everyone's,
 * and a banner would be claiming something that is not true.
 */
function bannerPayload() {
    if (!S || !S.defends) return [];
    const b = bcfg();
    const g = Object.assign({}, P.hoopGeometry, TUNE);
    const a = (g.axisDeg * Math.PI) / 180;
    const along = v(Math.cos(a), Math.sin(a), 0);          // down the pitch
    const across = v(-Math.sin(a), Math.cos(a), 0);        // across it
    const hang = (P.bannerDropUnits || 600);
    const out = [];

    // ONE formula for both sizes. They used to derive yaw from different bases — the big one off the
    // pitch axis, the small ones off the ring's own yaw — so they disagreed with each other on the
    // same end, and each was right on a different side. Both now take the ring's facing, the same
    // per-end flip, and their own offset, which is the only term a slider needs to touch.
    const flip = (end) => (end > 0 ? 180 : 0);

    // ...and one BASIS per end, for the same reason. The two ends face 180 apart, so the banner's
    // own forward and its own right are both reversed at one of them. `fwd` mirrored and `side`
    // did not, which made the pair half local and half world: dial `side` until one end is
    // perfect and the other is off by twice the value, mirrored. Nothing about the yaw shows it,
    // because the yaw was already right.
    const axes = (end) => ({ fwd: scale(along, end), side: scale(across, end) });

    for (const [team, end] of Object.entries(S.defends)) {
        const mesh = (P.goalBanners || {})[team];
        if (!mesh) continue;
        const ring = HOOPS.filter((h) => h.end === end);
        if (!ring.length) continue;
        const tallest = ring.reduce((best, h) => (h.pos.z > best.pos.z ? h : best), ring[0]);

        // The big one, hanging above the tallest ring. Its spawn point is its TOP edge, so the lift
        // has to carry its own hanging length as well as the gap we want.
        const ax = axes(end);
        const at = add(add(tallest.pos, scale(ax.fwd, b.fwd)), scale(ax.side, b.side));
        out.push({
            mesh, team,
            x: at.x, y: at.y, z: at.z + b.lift + hang * b.scale,
            yaw: tallest.yaw + flip(end) + b.yaw,
            scale: b.scale,
        });

        if (!b.perHoop) continue;
        for (const h of ring) {
            const p = add(add(h.pos, scale(ax.fwd, b.hoopFwd)), scale(ax.side, b.hoopSide));
            out.push({
                mesh, team,
                x: p.x, y: p.y, z: p.z - b.hoopGap,
                yaw: h.yaw + flip(end) + b.hoopYaw,
                scale: b.hoopScale,
            });
        }
    }
    return out;
}
// Banners are plain server world objects, so they stream to everyone in range — late joiners and
// spectators included — and replacing the set is the only bookkeeping they need.
let bannerKeys = [];
function placeBanners(banners) {
    for (const key of bannerKeys) { try { WorldObject.destroy(key); } catch (_) {} }
    bannerKeys = [];
    banners.forEach((b, i) => {
        const key = `quidditch:banner:${i}`;
        try {
            if (WorldObject.create(key, b.mesh, { x: b.x, y: b.y, z: b.z, yaw: b.yaw, scale: b.scale, collision: false })) bannerKeys.push(key);
        } catch (e) {
            console.log(`[QUIDDITCH] banner ${b.mesh} did not spawn: ${e.message}`);
        }
    });
}

// Bludgers are server world objects too: the tick writes their position and every client in range
// interpolates it, so late joiners and spectators see them without a per-player stream.
const MAX_BLUDGERS = 8;
const bludgerKey = (i) => `quidditch:bludger:${i}`;
function placeBludger(b, i) {
    try {
        b.obj = WorldObject.create(bludgerKey(i), CONFIG.bludgers.mesh, {
            x: b.pos.x, y: b.pos.y, z: b.pos.z, scale: CONFIG.bludgers.scale || 1, collision: false,
            fx: CONFIG.bludgers.trail, fxSocket: CONFIG.bludgers.trailSocket,
        }) || null;
    } catch (e) {
        b.obj = null;
        console.log(`[QUIDDITCH] bludger ${i} did not spawn: ${e.message}`);
    }
}
function clearBludgers() {
    for (let i = 0; i < MAX_BLUDGERS; i++) { try { WorldObject.destroy(bludgerKey(i)); } catch (_) {} }
}

// The quaffle is a server physics object: the nearest client simulates it, its carrier holds it,
// and where it is comes from `obj.position`, not from a reporter we elected ourselves.
const QUAFFLE_KEY = "quidditch:quaffle";
const TEST_QUAFFLE_KEY = "quidditch:testball";
function spawnQuaffle(key, at) {
    const b = CONFIG.ball || {};
    if (!b.mesh) return null;
    try {
        return WorldObject.create(key, b.mesh, { x: at.x, y: at.y, z: at.z, physics: true, massKg: b.massKg || 2 }) || null;
    } catch (e) {
        console.log(`[QUIDDITCH] quaffle did not spawn: ${e.message}`);
        return null;
    }
}
function clearQuaffle() {
    try { WorldObject.destroy(QUAFFLE_KEY); } catch (_) {}
}

// Race rings are Blueprints too; each client raises the grow-in on the one it streams.
const RING_CLASS = "/Game/Gameplay/BroomRaces/Blueprints/BP_RaceRing.BP_RaceRing_C";
const hoopKey = (i) => `quidditch:hoop:${i}`;
let hoopCount = 0;
function clearHoopObjects() {
    for (let i = 0; i < hoopCount; i++) { try { WorldObject.destroy(hoopKey(i)); } catch (_) {} }
    hoopCount = 0;
}
function placeHoops() {
    clearHoopObjects();
    HOOPS.forEach((h, i) => {
        try { WorldObject.create(hoopKey(i), RING_CLASS, { x: h.pos.x, y: h.pos.y, z: h.pos.z, yaw: h.yaw }); }
        catch (e) { console.log(`[QUIDDITCH] hoop ${i} did not spawn: ${e.message}`); }
    });
    hoopCount = HOOPS.length;
}

// One client flies the shipped snitch Blueprint for everyone. The flight model here only steers it
// through the object's state, and a catch is judged against where that client says it is.
const SNITCH_CLASS = "/Game/Levels/WorldEvents/Blueprints/LooseSnitch/BP_Loose_Snitch.BP_Loose_Snitch_C";
const SNITCH_KEY = "quidditch:snitch";
function spawnSnitch() {
    const c = CONFIG.snitch;
    const at = add(CENTRE, v(0, 0, 2500));
    S.snitch.sentRoam = null;
    S.snitch.sentSpeed = null;
    try {
        S.snitch.obj = WorldObject.create(SNITCH_KEY, SNITCH_CLASS, {
            x: at.x, y: at.y, z: at.z, scale: c.scale || 1, simulated: true,
            fx: (c.trailScale || 0) > 0 ? c.trail : "",
        }) || null;
    } catch (e) {
        S.snitch.obj = null;
        console.log(`[QUIDDITCH] snitch did not spawn: ${e.message}`);
    }
}
function clearSnitch() {
    try { WorldObject.destroy(SNITCH_KEY); } catch (_) {}
    if (S) S.snitch.obj = null;
}

function pushBanners() {
    const banners = bannerPayload();
    if (!banners.length) {
        console.log("[QUIDDITCH] no goal banners: no ends assigned, or no mesh for those houses");
    }
    placeBanners(banners);
}

// `preview` places them with no session running, so the tuning commands can be checked by eye.
function pushHoops(preview) {
    if (S || preview) placeHoops();
    pushBanners();   // the hoops moved, so the markers over them have to follow
}

function tuning() {
    return Object.assign({}, P.hoopGeometry, TUNE);
}

/**
 * Did the segment a->b cross the hoop's disc? Returns the crossing side (+1 through the front,
 * -1 through the back) or 0. The segment is what makes this reliable at speed — sampling positions
 * and testing each one in isolation is the version that loses goals.
 */
function crossedHoop(hoop, a, b) {
    const n = hoop.normal;
    const da = dot(sub(a, hoop.pos), n);
    const db = dot(sub(b, hoop.pos), n);
    if ((da > 0) === (db > 0)) return 0;
    const t = da / (da - db || 1e-6);
    const hit = add(a, scale(sub(b, a), t));
    const radial = sub(hit, hoop.pos);
    const inPlane = sub(radial, scale(n, dot(radial, n)));
    if (len(inPlane) > (CONFIG.scoring.hoopRadius || 383)) return 0;
    return da > 0 ? 1 : -1;
}

function insideEnvelope(p) {
    const e = P.envelope;
    return Math.abs(p.x - CENTRE.x) <= e.xy && Math.abs(p.y - CENTRE.y) <= e.xy
        && p.z <= CENTRE.z + e.up && p.z >= CENTRE.z - e.down;
}

// ---------------------------------------------------------------- session state

let S = null; // null = idle

function freshSession(mode) {
    return {
        mode,
        startedAt: Date.now(),
        endsAt: Date.now() + (CONFIG.scoring.matchSeconds || 900) * 1000,
        players: new Map(),           // playerId -> { player, team, role, lastPos, heldUntil }
        score: { gryffindor: 0, slytherin: 0, hufflepuff: 0, ravenclaw: 0 },
        ball: { id: 0, pos: add(CENTRE, v(0, 0, 2000)), prev: null, carrier: null, loose: true },
        // `releaseAt` is when it is let out; `releasedAt` is when it was. Everything about the
        // snitch -- stepping, catching, fatigue, the HUD -- is gated on the second being set.
        snitch: { pos: null, target: null, hidden: false, legEnds: 0, holder: null, heldMs: 0,
                  caught: false, releaseAt: 0, releasedAt: 0 },
        // Seats emptied by a disconnect, keyed by NAME: a reconnecting player is a new connection
        // id, and the id is the one thing about them that did change.
        vacated: new Map(),
        bludgers: [],
        stunned: new Map(),           // playerId -> until ms
        ambience: null,               // ids of the looping stadium beds, stopped in endSession
        defends: null,                // team -> which pitch end (+1/-1) it keeps; null = free-for-all

        finished: false,
    };
}

// Events.onClient hands the payload already PARSED. JSON.parse on an object throws, and a throw
// inside a try/catch here reads as "the client sent nothing" — silent, and it killed four handlers.
function payload(raw) {
    if (raw && typeof raw === "object") return raw;
    try { return JSON.parse(raw || "{}"); } catch (_) { return null; }
}

const seats = () => (S ? [...S.players.values()] : []);
const seatOf = (player) => (S ? S.players.get(player.id) : undefined);

function broadcast(event, payload) {
    for (const seat of seats()) { try { seat.player.emit(event, JSON.stringify(payload)); } catch (_) {} }
}

function clearMatchBlips() {
    FoundationBlips.markers.clear(RESOURCE);
}

function syncMatchBlips() {
    if (!S) { clearMatchBlips(); return; }
    const audience = seats().map((seat) => seat.player);
    const updates = [];
    if (S.ball && S.ball.pos) updates.push(FoundationBlips.markers.upsert({
        resource: RESOURCE, id: "quaffle", kind: "marker", position: S.ball.pos,
        label: "Quaffle", showOnHud: true, showDistance: false, ttl: 2, audience,
    }));
    // Marks the snitch its simulator flies, which is the one a catch is judged against.
    const snitchAt = S.snitch && S.snitch.obj ? S.snitch.obj.position : null;
    if (CONFIG.snitch.blip && snitchAt && !S.snitch.hidden) {
        const at = v(snitchAt.x, snitchAt.y, snitchAt.z);
        updates.push(FoundationBlips.markers.upsert({ resource: RESOURCE, id: "snitch", kind: "marker",
            position: at, label: "Snitch", showOnHud: true, showDistance: true, ttl: 2, audience }));
        updates.push(FoundationBlips.markers.upsert({ resource: RESOURCE, id: "snitch-radius", kind: "circle",
            position: at, radius: 8, ttl: 2, audience }));
    } else {
        FoundationBlips.markers.remove("snitch", RESOURCE);
        FoundationBlips.markers.remove("snitch-radius", RESOURCE);
    }
    for (let i = 0; i < 8; i++) {
        const bludger = CONFIG.bludgers.blip && S.bludgers[i];
        if (bludger) updates.push(FoundationBlips.markers.upsert({ resource: RESOURCE, id: `bludger-${i}`,
            kind: "circle", position: bludger.pos, radius: 3, ttl: 2, audience }));
        else FoundationBlips.markers.remove(`bludger-${i}`, RESOURCE);
    }
    void Promise.all(updates).catch((error) => logger.warn(`Could not update match blips: ${error}`));
}

function announce(text) {
    for (const seat of seats()) {
        try { seat.player.sendChat(text); } catch (_) {}
        try { Ui.notify(seat.player, { title: "Quidditch", description: text }); } catch (_) {}
    }
}

// ---------------------------------------------------------------- sound

const SFX = CONFIG.sounds || {};

/** Every post is optional: an empty or missing event name silences that cue rather than throwing. */
function sfxAll(event) {
    if (!event) return 0;
    try { return FoundationAudio.sounds.playForAll(AUDIO_OWNER, event) || 0; } catch (_) { return 0; }
}

function sfxAt(event, p) {
    if (!event || !p) return 0;
    try { return FoundationAudio.sounds.playAt(AUDIO_OWNER, event, p, { range: 30000 }) || 0; } catch (_) { return 0; }
}

function sfxFor(player, event) {
    if (!event || !player) return 0;
    try { return FoundationAudio.sounds.playForPlayer(AUDIO_OWNER, player, event) || 0; } catch (_) { return 0; }
}

/** The side that scored hears a cheer; everyone else hears the crowd's disappointment. */
function sfxGoal(team) {
    if (!team) { sfxAll(SFX.goalNeutral); }
    else {
        for (const seat of seats()) {
            sfxFor(seat.player, seat.team === team ? SFX.goalCheer : SFX.goalGroan);
        }
    }
    sfxAll(SFX.goalSting);
}

/**
 * The stadium beds are LOOPS, so unlike every other cue here they have to be stopped by hand — a
 * one-shot ends itself, a loop outlives the session and follows the player off the pitch.
 */
function startAmbience() {
    if (!S) return;
    S.ambience = [sfxAll(SFX.ambienceField), sfxAll(SFX.ambienceStands)].filter(Boolean);
}

function stopAmbience() {
    if (!S || !S.ambience) return;
    for (const id of S.ambience) { try { FoundationAudio.sounds.stop(AUDIO_OWNER, id); } catch (_) {} }
    S.ambience = null;
}

/**
 * The bar across the top: two sides, the clock, and who holds the quaffle.
 *
 * Sides come from the FIXTURE where there is one, so left and right mean the end each house
 * keeps and match the banners hanging over those hoops. Without ends -- a free-for-all, a solo
 * session -- it falls back to the distinct teams actually seated, and a missing side renders as
 * nothing rather than as a team on nil.
 */
function scoreTree() {
    if (!S) return null;
    const colours = CONFIG.houseColours || {};
    const holder = ballHolder();
    let order;
    if (S.defends) {
        // +1 on the left, -1 on the right, so the bar reads in the same order as the pitch.
        order = Object.keys(S.defends).sort((a, b) => S.defends[b] - S.defends[a]);
    } else {
        order = [...new Set(seats().map((x) => x.team).filter(Boolean))];
    }
    const side = (team) => (team ? {
        team,
        colour: colours[team] || "#8a8a8a",
        score: S.score[team] || 0,
        holding: !!holder && holder.team === team,
    } : null);
    return {
        left: side(order[0]),
        right: side(order[1]),
        mode: (CONFIG.modes[S.mode] || {}).label || S.mode,
        endsAt: S.endsAt,
    };
}

/** Cheap enough to send whole: four numbers and two strings, only when one of them moved. */
function pushScore(only) {
    const tree = scoreTree();
    if (!tree) return;
    const targets = only ? [only] : seats().map((x) => x.player);
    for (const p of targets) { try { p.emit("quidditch:scoreboard", JSON.stringify(tree)); } catch (_) {} }
}

function publishScoreboard() {
    if (!S) { try { World.state?.remove("quidditchMatch"); } catch (_) {} return; }
    const payload = {
        mode: S.mode,
        score: S.score,
        endsAt: S.endsAt,
        players: seats().map((s) => ({ id: s.player.id, team: s.team, role: s.role })),
    };
    try { World.state?.set("quidditchMatch", payload); } catch (_) {}
}

// ---------------------------------------------------------------- snitch

function snitchVolumeSample() {
    const c = CONFIG.snitch.volume;
    return add(CENTRE, v((Math.random() * 2 - 1) * c.xy, (Math.random() * 2 - 1) * c.xy,
        c.minZ + Math.random() * (c.maxZ - c.minZ)));
}

// 1 while fresh, decaying to `floor` once the hunt has run long enough. Everything the snitch does
// to stay away from you scales by this, and the catch radius grows as its inverse.
function snitchFatigue(now) {
    const f = CONFIG.snitch.fatigue;
    if (!f || !S.snitch.releasedAt) return 1;
    // From RELEASE, not from kickoff: a snitch let out at five minutes has done no flying yet.
    const elapsed = (now - S.snitch.releasedAt) / 1000 - (f.graceSec || 0);
    if (elapsed <= 0) return 1;
    const t = clamp(elapsed / (f.rampSec || 180), 0, 1);
    return 1 - t * (1 - (f.floor ?? 0.45));
}

/**
 * How far through the tiring, 0..1 — NOT the speed multiplier.
 *
 * `snitchFatigue` bottoms out at `floor`, so `1 - fatigue` maxes out at `1 - floor`: with the
 * default 0.45 the HUD read "tiring 55%" at maximum tiredness and could never reach 100%, and
 * `radiusBonus` delivered 55% of its configured centimetres. Progress is the honest number for both.
 */
/**
 * Let it out. Announced everywhere at once, because it changes what everybody on the pitch is
 * doing -- the seekers start hunting and everyone else has a clock on them now.
 */
function releaseSnitch() {
    if (!S || S.snitch.releasedAt) return;
    S.snitch.releasedAt = Date.now();
    spawnSnitch();
    broadcast("quidditch:resnitch", { id: S.snitch.obj ? S.snitch.obj.id : 0, released: true });
    announce("The Snitch is released!");
    broadcast("quidditch:banner", { size: "goal", text: "The Snitch is released" });
    sfxAll(SFX.snitchRelease || SFX.goalSting);
    for (const seat of seats()) pushHud(seat);   // the countdown becomes the proximity bar
}

function snitchWear(now) {
    const f = CONFIG.snitch.fatigue;
    if (!f || !S.snitch.releasedAt) return 0;
    // From RELEASE, not from kickoff: a snitch let out at five minutes has done no flying yet.
    const elapsed = (now - S.snitch.releasedAt) / 1000 - (f.graceSec || 0);
    if (elapsed <= 0) return 0;
    return clamp(elapsed / (f.rampSec || 180), 0, 1);
}

/**
 * The distance the CATCH is judged on — one definition, used by the test and by the HUD.
 *
 * It is measured to the snitch every client sees, which is the one its simulator flies. The point
 * the flight model steers by only aims that snitch; nobody can see it.
 */
function catchDistance(seat) {
    const sn = S.snitch;
    const at = sn.obj ? sn.obj.position : sn.pos;
    if (!seat.lastPos || !at) return Infinity;
    return dist(seat.lastPos, v(at.x, at.y, at.z));
}

function catchRadiusNow(now) {
    const f = CONFIG.snitch.fatigue;
    return CONFIG.snitch.catchRadius + snitchWear(now) * ((f && f.radiusBonus) || 0);
}

function seekers() {
    const all = seats();
    // snitchHunt is the mode where EVERYONE hunts. That is the game there, not a lapse in the
    // rule below, so it is exempt by mode rather than by an empty role list.
    if (S.mode === "snitchHunt") return all;

    const named = all.filter((seat) => roleAllowed(seat, CONFIG.snitch.catchRoles));
    if (named.length) return named;

    // Nobody on the pitch holds the role, so the snitch would be uncatchable and a match could
    // never end by catch. The roster still gets it -- but out loud, once. A rule that suspends
    // itself in silence is the kind you spend an evening disbelieving.
    if (!S.saidNoSeeker) {
        S.saidNoSeeker = true;
        console.log("[QUIDDITCH] no seat holds a catch role — the snitch is open to the roster");
        announce("No Seeker on the pitch — the Snitch is anyone's.");
    }
    return all;
}

function randomUnit() {
    // Biased flat: a snitch that spends its time climbing and diving is much harder to read than
    // one that works the horizontal plane, and the volume is far wider than it is tall.
    const a = Math.random() * Math.PI * 2;
    const z = (Math.random() * 2 - 1) * 0.45;
    return norm(v(Math.cos(a), Math.sin(a), z));
}

/**
 * One leg = one short hop along a mostly-continuous heading. The previous heading carries most of
 * the weight, a little randomness turns it, and a nearby seeker pushes it away. Sampling a fresh
 * point from the whole volume instead makes it teleport and become uncatchable.
 */
function nextSnitchLeg(now) {
    const sn = S.snitch;
    const cfg = CONFIG.snitch;
    if (!sn.heading) sn.heading = randomUnit();

    let nearest = null;
    for (const seat of seekers()) {
        const p = seat.lastPos;
        if (!p) continue;
        if (!nearest || dist(p, sn.pos) < dist(nearest, sn.pos)) nearest = p;
    }
    const threatened = nearest && dist(nearest, sn.pos) < cfg.fleeRadius;

    let dir = add(scale(sn.heading, cfg.momentum), scale(randomUnit(), cfg.wander));
    if (threatened) dir = add(dir, scale(norm(sub(sn.pos, nearest)), cfg.fleeStrength * snitchFatigue(now)));
    sn.heading = norm(dir);

    const wear = snitchFatigue(now);
    const speed = (threatened ? cfg.fleeSpeed : cfg.cruiseSpeed) * wear;
    let target = add(sn.pos, scale(sn.heading, speed * cfg.legSeconds));

    // Bounce off the airspace walls rather than clamping flat — a clamped snitch pins itself into a
    // corner and hovers there.
    const c = cfg.volume;
    const lo = v(CENTRE.x - c.xy, CENTRE.y - c.xy, CENTRE.z + c.minZ);
    const hi = v(CENTRE.x + c.xy, CENTRE.y + c.xy, CENTRE.z + c.maxZ);
    const axes = [["x", lo.x, hi.x], ["y", lo.y, hi.y], ["z", lo.z, hi.z]];
    for (const [axis, min, max] of axes) {
        if (target[axis] < min || target[axis] > max) {
            sn.heading[axis] = -sn.heading[axis];
            target[axis] = clamp(target[axis], min, max);
        }
    }

    sn.target = target;
    sn.legEnds = now + cfg.legSeconds * 1000;

    // No feinting on its last legs. A spent snitch that still vanishes reads as a trick rather than
    // exhaustion, and with floor 0 it would be the only thing it could still do.
    if (threatened && snitchWear(now) < 0.9 && Math.random() < cfg.feintChance) {
        sn.hidden = true;
        setTimeout(() => { if (S && S.snitch === sn) sn.hidden = false; }, cfg.feintHideMs);
    }
}

function stepSnitch(now) {
    const sn = S.snitch;
    if (sn.caught) return;
    if (!sn.pos) { sn.pos = snitchVolumeSample(); sn.target = sn.pos; sn.legEnds = 0; }
    // Frozen still runs the catch check below — that is the whole point of freezing it, to test the
    // catch against a target that is definitely not moving away from you.
    if (!sn.frozen && now >= sn.legEnds) nextSnitchLeg(now);

    if (!sn.frozen) {
        const legLeft = Math.max(1, sn.legEnds - now);
        const k = clamp(TICK_MS / legLeft, 0, 1);
        sn.pos = add(sn.pos, scale(sub(sn.target, sn.pos), k));
    }

    // Steer the puppet at the LIVE authoritative point, not the leg's end. Aiming it at the end let
    // the BP fly its own randomly-bulged Bezier there while the server eased straight toward it —
    // so the snitch you can see and the snitch being tested for a catch drifted apart mid-leg, and
    // catching the visible one did nothing. Costs some of the organic swoop; worth it.
    if (!sn.beat || now - sn.beat >= (CONFIG.snitch.steerMs || 200)) {
        sn.beat = now;
        // The BP's OWN play-rate has to tire too. Steering only moves the box it picks destinations
        // in; left at its default the snitch keeps flying full-speed arcs around a stationary box,
        // which is exactly what "100% tired and still zipping about" was.
        const mult = sn.frozen ? 0 : snitchFatigue(now);
        // ROAM is what stops a tired snitch, not speed: a leg is a lerp over a 1 s timeline, so its
        // duration is 1/rate REGARDLESS of distance. Shrinking the box shortens the leg; cutting the
        // rate only makes the same leg glacial.
        const roam = Math.max(CONFIG.snitch.roamMin ?? 60, (CONFIG.snitch.roam ?? 3000) * mult);
        // The rate therefore has a real floor. Driving it near zero — which freezing used to do —
        // strands the mesh mid-flight crawling toward a box it never reaches, so the snitch you can
        // see ends up tens of metres from the one being tested, and neither freeze nor "bring to me"
        // can recover it. At 1.0 a leg always completes within a second, so the puppet keeps up.
        const base = CONFIG.snitch.bpSpeed ?? 3.0;
        const rate = Math.round(Math.max(CONFIG.snitch.bpSpeedMin ?? 1.0, base * mult) * 1000) / 1000;
        const reach = Math.round(roam);
        if (sn.obj) {
            try {
                sn.obj.state.set("snitch.x", sn.pos.x);
                sn.obj.state.set("snitch.y", sn.pos.y);
                sn.obj.state.set("snitch.z", sn.pos.z);
                if (rate !== sn.sentSpeed) { sn.obj.state.set("snitch.speed", rate); sn.sentSpeed = rate; }
                if (reach !== sn.sentRoam) { sn.obj.state.set("snitch.roam", reach); sn.sentRoam = reach; }
            } catch (e) {
                logger.warn(`Snitch steering failed: ${e.message}`);
            }
        }
    }

    for (const seat of seekers()) {
        const p = seat.lastPos;
        if (!p) continue;
        if (catchDistance(seat) <= catchRadiusNow(now)) {
            if (sn.holder !== seat.player.id) {
                sn.holder = seat.player.id;
                sn.heldMs = 0;
                try { seat.player.emit("quidditch:catching", JSON.stringify({ on: true, ms: CONFIG.snitch.catchHoldMs })); } catch (_) {}
            }
            else { sn.heldMs += TICK_MS; }
            if (sn.heldMs >= CONFIG.snitch.catchHoldMs) { catchSnitch(seat); return; }
        }
        else if (sn.holder === seat.player.id) {
            // A brief grace, so a single tick of drift does not reset a hold that is going fine.
            sn.heldMs -= TICK_MS * 2;
            if (sn.heldMs <= 0) {
                sn.holder = null;
                sn.heldMs = 0;
                try { seat.player.emit("quidditch:catching", JSON.stringify({ on: false })); } catch (_) {}
            }
        }
    }
}

function catchSnitch(seat) {
    clearCatchBar();
    S.snitch.caught = true;

    // Never name a house at random. This read `seat.team || "gryffindor"`, so a seat that somehow
    // reached here without a side had one invented for it -- and an invented house is worse than
    // none, because everyone watching believes the announcement.
    const team = seat.team || playerHouse(seat.player);
    if (!team) console.error(`[QUIDDITCH] snitch caught by ${seat.player.id} with no team and no house`);

    if (team) S.score[team] = (S.score[team] || 0) + CONFIG.snitch.points;
    pushScore();
    announce(team
        ? `The Snitch is caught! ${CONFIG.snitch.points} to ${team}.`
        : `The Snitch is caught! ${CONFIG.snitch.points} points, unclaimed.`);
    // Crowd only here — the end-gate firework arrives a beat later from finishSession, so playing a
    // sting too would stack three cues on one moment.
    sfxAll(SFX.victory);
    void recordLeaderboard(seat, "snitch").catch((error) => logger.warn(`Could not save snitch statistic: ${error}`));
    if (seat.stats) seat.stats.snitch++;
    // Before the teardown broadcast below — in snitchHunt and match this ends the session, and
    // teardown destroys the overlay view the banner would have drawn in.
    if (team) {
        broadcast("quidditch:banner", {
            size: "snitch", house: team, text: "The Snitch is caught",
            subLead: team, subTail: `· +${CONFIG.snitch.points}`, holdMs: 4200,
        });
    }
    broadcast("quidditch:snitchCaught", { by: seat.player.id });
    clearSnitch();
    publishScoreboard();
    if (S.mode === "snitchHunt" || S.mode === "match") {
        finishSession("snitch", CONFIG.scoring.celebrateMs ?? 14000);
    }
}

// ---------------------------------------------------------------- ball + goals

function ballHolder() {
    if (!S || !S.ball.carrier) return null;
    return S.players.get(S.ball.carrier) || null;
}

/**
 * Whose simulation of the loose ball the server believes.
 *
 * The server integrates no physics of its own, so without this it never learns that a loose ball
 * fell: it spawns at centre+20 m, every client's copy drops to the deck, and the server keeps
 * testing pickups against the empty air the ball started in. That deadlocked possession outright —
 * you could not pick the ball up, so you could not throw it, so `lastThrower` stayed null and the
 * only path that corrected the position never opened.
 *
 * The thrower reports while a throw is in the air. Otherwise it is the lowest player id present —
 * arbitrary but *stable*, which is the property that matters: every client simulates its own copy
 * and they drift, so exactly one has to be the one we believe.
 */
/**
 * Is this seat's ROLE allowed to do this? An absent or empty list means the action carries no
 * role restriction, so a config that says nothing keeps the old behaviour of anyone-may.
 */
const roleAllowed = (seat, roles) =>
    !Array.isArray(roles) || !roles.length || roles.includes(seat.role);

/** Said out loud. A silent refusal is indistinguishable from the key not working. */
function refuseByRole(seat, what, roles) {
    const who = roles.map(cap1).join(" or ");
    try { seat.player.emit("quidditch:notice", JSON.stringify({ text: `Only a ${who} may ${what}.` })); } catch (_) {}
}

/** No arbitration exists in the game, so possession is decided here or not at all. */
function grantPossession(seat) {
    if (!S || S.ball.carrier === seat.player.id) return false;
    // Here rather than at each call site: the wheel, the hotkey and the fallback bind all arrive
    // through this one function, and an offer is only advisory -- a client names an action by id.
    if (!roleAllowed(seat, CONFIG.ball.carryRoles)) {
        refuseByRole(seat, "carry the Quaffle", CONFIG.ball.carryRoles);
        return false;
    }
    if (seat.noCarryUntil && Date.now() < seat.noCarryUntil) return false;
    const now = Date.now();
    if (S.ball.heldUntil && now < S.ball.heldUntil) return false;

    // Read BEFORE possession is taken, because taking it is what makes the ball no longer loose.
    // Catching a ball an opponent put in the air is the Chaser's save, and it was the quietest
    // thing on the pitch: the only feedback was the taker's own "You have the Quaffle", which
    // nobody else could see. A pass completing stays silent -- that one is routine.
    const thrower = S.ball.loose && S.ball.lastThrower && S.ball.lastThrower !== seat.player.id
        ? S.players.get(S.ball.lastThrower) : null;
    const intercepted = !!thrower && !!thrower.team && thrower.team !== seat.team;

    S.ball.carrier = seat.player.id;
    S.ball.loose = false;
    if (S.ball.obj) S.ball.obj.attachTo(seat.player, CONFIG.ball.carrySocket || "WandSocket");
    sfxAt(SFX.catch, S.ball.pos);
    if (intercepted) announce(`${seat.player.nickname || "A chaser"} intercepts!`);
    pushScore();

    // Say so. A silent success is indistinguishable from a failure, and it read as one: taking the
    // ball offered no feedback at all, so the natural response was to press again — and the second
    // press is correctly refused, because the pickup is no longer on offer. The rejection warning
    // was the only signal the mechanic gave, and it was pointing at the wrong thing entirely.
    try { seat.player.emit("quidditch:notice", JSON.stringify({ text: "You have the Quaffle." })); } catch (_) {}
    // Immediately, not on the next 500 ms HUD beat — the card IS the ongoing "you are holding it".
    pushCarryCard(seat);
    // Rebuild context now so the E bind drops the moment it stops being legal, instead of lingering
    // until the next poll and inviting exactly the second press that produced the warning.
    if (Events.listenerCount("rp:ui:context:poke") > 0) {
        try { Events.emit("rp:ui:context:poke", seat.player); } catch (_) {}
    }
    return true;
}

function dropBall(reason) {
    if (!S || !S.ball.carrier) return;
    const seat = S.players.get(S.ball.carrier);
    S.ball.carrier = null;
    S.ball.loose = true;
    S.ball.heldUntil = Date.now() + 600; // brief immunity so the dropper cannot instantly re-grab
    if (S.ball.obj) S.ball.obj.detach();
    pushScore();
    if (seat) {
        try { seat.player.emit("quidditch:notice", JSON.stringify({ text: "You lost the Quaffle." })); } catch (_) {}
        pushCarryCard(seat);
        if (Events.listenerCount("rp:ui:context:poke") > 0) {
            try { Events.emit("rp:ui:context:poke", seat.player); } catch (_) {}
        }
    }
}

function stepBall() {
    const holder = ballHolder();
    const prev = S.ball.prev;
    if (holder && holder.lastPos) { S.ball.pos = add(holder.lastPos, v(0, 0, 60)); }
    else if (S.ball.obj) {
        const p = S.ball.obj.position;
        S.ball.pos = v(p.x, p.y, p.z);
    }
    S.ball.prev = S.ball.pos;
    if (!prev) return;
    if (holder) {
        // Haversacking: the carrier may not take it through themselves. A carried ball used to skip
        // the hoop test entirely, so flying it through did nothing at all — no goal, but no
        // consequence either, which is its own kind of silence.
        for (const hoop of HOOPS) {
            if (!crossedHoop(hoop, prev, S.ball.pos)) continue;
            announce(`${holder.player.nickname || "Carrier"} took it through — no goal.`);
            broadcast("quidditch:banner", { size: "goal", text: "Haversack — no goal" });
            fumble(holder, "haversack");
            resetBallToCentre();
            return;
        }
        return;
    }

    for (const hoop of HOOPS) {
        const side = crossedHoop(hoop, prev, S.ball.pos);
        if (!side) continue;
        // The scoring-area rule. A shot released on top of the hoop leaves no flight time, so the
        // keeper never had a chance to be anywhere — it is not a save they missed, it is a save that
        // was never possible. Waved off rather than scored.
        const minShot = (CONFIG.keeper && CONFIG.keeper.minShotDistance) || 0;
        if (minShot && S.ball.throwFrom && dist(S.ball.throwFrom, hoop.pos) < minShot) {
            announce(`Too close — a shot must be taken from beyond ${Math.round(minShot / 100)} m.`);
            broadcast("quidditch:banner", { size: "goal", text: "No goal — too close" });
            resetBallToCentre();
            return;
        }
        const scorer = S.ball.lastThrower ? S.players.get(S.ball.lastThrower) : null;
        let team = scorer ? scorer.team : null;
        // An own goal counts for the other side, as it does in every sport that has ends. Refusing to
        // score it would make your own hoops a safe place to dump the quaffle.
        let own = false;
        if (team && S.defends && S.defends[team] === hoop.end) {
            own = true;
            team = Object.keys(S.defends).find((x) => x !== team) || null;
        }
        if (team) {
            S.score[team] = (S.score[team] || 0) + CONFIG.scoring.goal;
            pushScore();
            announce(own
                ? `Own goal! ${CONFIG.scoring.goal} to ${team}.`
                : `Goal! ${CONFIG.scoring.goal} to ${team}.`);
            // An own goal is not the scorer's to be credited with — the points land, the stat does not.
            if (!own) {
                void recordLeaderboard(scorer, "goal").catch((error) => logger.warn(`Could not save goal statistic: ${error}`));
                if (scorer.stats) scorer.stats.goals++;
            }
            broadcast("quidditch:banner", {
                size: "goal", house: team, lead: team, tail: own ? "score — own goal" : "score",
                sub: `+${CONFIG.scoring.goal} · ${S.score[team]} total`,
            });
        }
        else {
            announce("Through the hoop!");
            broadcast("quidditch:banner", { size: "goal", text: "Through the hoop" });
        }
        sfxGoal(team);
        broadcast("quidditch:goal", { team, hoop: hoop.pos });
        resetBallToCentre();
        publishScoreboard();
        return;
    }

    if (!insideEnvelope(S.ball.pos)) resetBallToCentre();
}

function resetBallToCentre() {
    // Loud on purpose. A ball that falls through the pitch floor leaves the envelope, gets teleported
    // 35 m back up, and falls again — a silent ~2.7 s loop that reads in game as "the quaffle will
    // not stay put" and makes a pickup unpressable, because the distance the offer was built from is
    // stale by tens of metres the instant this fires. If this line repeats, that is the bug.
    if (S.ball.resetAt && Date.now() - S.ball.resetAt < 8000) {
        console.log(`[QUIDDITCH] ball reset AGAIN after ${Date.now() - S.ball.resetAt} ms `
            + `from (${Math.round(S.ball.pos.x)}, ${Math.round(S.ball.pos.y)}, ${Math.round(S.ball.pos.z)}) `
            + `— deck is ${Math.round(DECK_Z)}, envelope floor ${Math.round(CENTRE.z - P.envelope.down)}`);
    }
    S.ball.resetAt = Date.now();
    S.ball.pos = add(CENTRE, v(0, 0, 2000));
    S.ball.prev = null;
    S.ball.carrier = null;
    S.ball.loose = true;
    S.ball.lastThrower = null;
    S.ball.throwFrom = null;
    if (S.ball.obj) {
        S.ball.obj.detach();
        S.ball.obj.position = new Vector3(S.ball.pos.x, S.ball.pos.y, S.ball.pos.z);
        S.ball.obj.setVelocity(0, 0, 0);
    }
}

// ---------------------------------------------------------------- bludgers

/**
 * Is this point inside a hoop's scoring area? With `end` given, only that end's hoops count.
 *
 * Goals use the unrestricted form -- a goal is a goal wherever the ball crosses -- so the end is
 * opt-in rather than always applied.
 */
function inScoringArea(p, end) {
    if (!p) return false;
    const r = (CONFIG.keeper && CONFIG.keeper.scoringArea) || 2600;
    return HOOPS.some((h) => (end === undefined || h.end === end) && dist(p, h.pos) <= r);
}

/**
 * The end this seat keeps, or undefined when nobody keeps anything -- a free-for-all, or a solo
 * session with one side. Undefined is what makes the tackle test fall back to ANY area, which is
 * the right answer there: with no ends assigned, 'your own area' does not mean anything, and
 * making the tackle unusable would be a worse reading of it than making it unrestricted.
 */
const endKeptBy = (seat) =>
    (S && S.defends && seat && seat.team && S.defends[seat.team]) || undefined;

/**
 * Lose the ball, and lose the right to take it straight back.
 *
 * Dropping it is a moment; the lockout is the consequence. Without it a tackled chaser simply
 * re-grabs and tries the identical thing, and nothing about the attack has to change.
 */
function fumble(seat, reason) {
    if (!seat) return;
    const ms = (CONFIG.keeper && CONFIG.keeper.fumbleMs) || 12000;
    seat.noCarryUntil = Date.now() + ms;
    if (S.ball.carrier === seat.player.id) dropBall(reason);
    try {
        seat.player.emit("quidditch:notice", JSON.stringify({
            text: `Fumbled — you cannot carry for ${Math.round(ms / 1000)}s.`,
        }));
    } catch (_) {}
    pushFumbleCard(seat);
}

const fumbleCards = new Map();

function pushFumbleCard(seat) {
    if (Events.listenerCount("rp:ui:hud") === 0) return;
    const id = seat.player.id;
    const draw = () => {
        const left = (seat.noCarryUntil || 0) - Date.now();
        if (left <= 0 || !S) {
            const h = fumbleCards.get(id);
            if (h) clearInterval(h);
            fumbleCards.delete(id);
            try { Events.emit("rp:ui:hud", seat.player, "quidditch:fumble", null); } catch (_) {}
            return;
        }
        try {
            Events.emit("rp:ui:hud", seat.player, "quidditch:fumble", {
                kind: "meter", label: "Fumbled", value: Math.round(left),
                max: (CONFIG.keeper && CONFIG.keeper.fumbleMs) || 12000,
                order: 24, tone: "red", detail: `${Math.ceil(left / 1000)}s`,
            });
        } catch (_) {}
    };
    const prev = fumbleCards.get(id);
    if (prev) clearInterval(prev);
    fumbleCards.set(id, setInterval(draw, 250));
    draw();
}

/**
 * Put hands on a carrier inside the scoring area. The Keeper's, and only the Keeper's: this is
 * what makes a chaser camping the hoops a risk rather than a free shot, and it is the Keeper the
 * risk is supposed to come from. The announcement below always said "Keeper"; the gate is new.
 */
function tackle(seat) {
    if (!S || !seat.lastPos) return false;
    const now = Date.now();
    const k = CONFIG.keeper || {};
    if (!roleAllowed(seat, k.tackleRoles)) {
        refuseByRole(seat, "tackle the carrier", k.tackleRoles);
        return false;
    }
    if (seat.tackledAt && now - seat.tackledAt < (k.tackleCooldownMs || 2000)) return false;
    const carrier = ballHolder();
    if (!carrier || carrier.player.id === seat.player.id || !carrier.lastPos) return false;
    if (dist(seat.lastPos, carrier.lastPos) > (k.tackleRadius || 700)) return false;
    // Their OWN scoring area. This exists to make camping a hoop risky, not to turn the whole
    // pitch into a wrestling match -- and a Keeper who could tackle at either end was licensed to
    // chase a carrier the length of the pitch and take the ball off them in front of their own
    // goal, which is the opposite of keeping.
    if (!inScoringArea(carrier.lastPos, endKeptBy(seat))) return false;
    seat.tackledAt = now;
    announce(`${seat.player.nickname || "Keeper"} tackles ${carrier.player.nickname || "the carrier"}!`);
    sfxAt(k.blockSound || "", carrier.lastPos);
    fumble(carrier, "tackle");
    try { carrier.player.emit("quidditch:knock", JSON.stringify({ ms: k.tackleStunMs || 700 })); } catch (_) {}
    return true;
}

/** Deflect a loose ball along the keeper's aim — the clearing kick, not a catch. */
function blockBall(seat, aim) {
    if (!S || !S.ball.loose || S.ball.carrier || !seat.lastPos) return false;
    if (!roleAllowed(seat, (CONFIG.keeper || {}).blockRoles)) {
        refuseByRole(seat, "clear the ball", (CONFIG.keeper || {}).blockRoles);
        return false;
    }
    const now = Date.now();
    if (seat.blockedAt && now - seat.blockedAt < ((CONFIG.keeper && CONFIG.keeper.blockCooldownMs) || 800)) return false;
    if (dist(seat.lastPos, S.ball.pos) > ((CONFIG.keeper && CONFIG.keeper.blockRadius) || 1000)) return false;
    seat.blockedAt = now;

    const dir = aim && typeof aim.x === "number"
        ? norm(v(aim.x, aim.y, aim.z)) : norm(sub(S.ball.pos, seat.lastPos));
    const speed = (CONFIG.keeper && CONFIG.keeper.blockSpeed) || 2400;
    // A cleared ball belongs to nobody: the keeper should not become the scorer if it later goes in,
    // and the scoring-area rule would wave that off anyway.
    S.ball.lastThrower = null;
    S.ball.throwFrom = null;
    S.ball.prev = S.ball.pos;
    if (S.ball.obj) S.ball.obj.setVelocity(dir.x * speed, dir.y * speed, dir.z * speed);
    broadcast("quidditch:ballThrow", {});
    sfxAt((CONFIG.keeper && CONFIG.keeper.blockSound) || "", S.ball.pos);
    announce(`${seat.player.nickname || "The keeper"} clears it!`);
    return true;
}

/** The bludger a swing would connect with: nearest inside swingRadius, or null. */
function nearestBludger(seat) {
    if (!S || !seat.lastPos || !S.bludgers.length) return null;
    const reach = CONFIG.bludgers.swingRadius || 1400;
    let best = null, bestD = reach;
    for (const b of S.bludgers) {
        const d = dist(seat.lastPos, b.pos);
        if (d <= bestD) { best = b; bestD = d; }
    }
    return best;
}

/**
 * Bat it away. The client supplies aim only and the server re-derives the launch, exactly as a
 * throw does — a swing is a throw you do not have to be holding anything for.
 *
 * The immunity window is what makes this feel fair rather than random: without it the bludger you
 * just hit is still inside its own hit radius on the next tick and knocks you off for your trouble.
 */
function swingAt(seat, aim) {
    if (!roleAllowed(seat, CONFIG.bludgers.swingRoles)) {
        refuseByRole(seat, "bat a Bludger", CONFIG.bludgers.swingRoles);
        return false;
    }
    const now = Date.now();
    if (seat.swungAt && now - seat.swungAt < (CONFIG.bludgers.swingCooldownMs || 700)) return false;
    const b = nearestBludger(seat);
    if (!b) return false;
    seat.swungAt = now;

    // No aim reported yet? Send it away from the swinger, which is the sane default.
    const dir = aim && typeof aim.x === "number" ? norm(v(aim.x, aim.y, aim.z)) : norm(sub(b.pos, seat.lastPos));
    b.vel = dir;
    b.speed = CONFIG.bludgers.swingSpeed || 2600;
    b.cur = CONFIG.bludgers.speedMin;
    b.speedUntil = now + 2500;
    b.immuneTo = seat.player.id;
    b.immuneUntil = now + (CONFIG.bludgers.swingImmuneMs || 1200);
    b.targetId = null;                       // re-picks a victim once the immunity lapses
    // Whose side sent it. A Beater's job is to put a bludger on an OPPONENT, so when it stops
    // flying straight it hunts the other team first rather than whoever happens to be nearest.
    b.sentBy = seat.team;
    sfxAt(CONFIG.bludgers.swingHit, b.pos);
    try { seat.player.emit("quidditch:swung", JSON.stringify({})); } catch (_) {}
    return true;
}

function stepBludgers(now) {
    if (!S.bludgers.length) return;
    const targets = seats().filter((s) => s.lastPos);
    if (!targets.length) return;
    // Frozen holds them in place AND stops them hitting. Unlike the snitch's freeze, which keeps its
    // catch test running on purpose, this one is for getting a bludger out of the way while working
    // on something else — a frozen bludger that still knocked you about would defeat the point.
    if (S.bludgersFrozen) return;
    for (const b of S.bludgers) {
        const batted = b.speedUntil && now < b.speedUntil;
        // A batted bludger holds the line it was hit along. Homing straight back at the swinger
        // would make the swing pointless — the whole point of hitting it is that it goes somewhere.
        if (!batted) {
            // Skip anyone still immune entirely — otherwise a bludger shadows a player it
            // cannot hit, waiting out their window at point-blank range.
            const eligible = seats().filter((s) => s.lastPos
                && !((S.stunned.get(s.player.id) || 0) > now)
                && !(b.immuneUntil && now < b.immuneUntil && s.player.id === b.immuneTo));
            if (!eligible.length) continue;
            let target = S.players.get(b.targetId);
            if (!target || !target.lastPos || !eligible.includes(target)) {
                // A batted bludger goes after the other side. Only falls back to the full field when
                // nobody on the other side is available — a solo session being the obvious case.
                const foes = b.sentBy ? eligible.filter((s) => s.team !== b.sentBy) : [];
                const pool = foes.length ? foes : eligible;
                target = pool[Math.floor(Math.random() * pool.length)];
                b.targetId = target.player.id;
                b.sentBy = null;   // one bat, one directed hunt
            }
            const toward = norm(sub(target.lastPos, b.pos));
            b.vel = norm(add(scale(norm(b.vel), 1 - CONFIG.bludgers.homingStrength),
                scale(toward, CONFIG.bludgers.homingStrength)));
        }
        // Wind-up: a homing bludger accelerates toward speedMax and is knocked back to speedMin by
        // every hit and every bat, so its menace has to rebuild each time rather than being constant.
        if (b.cur === undefined) b.cur = CONFIG.bludgers.speedMin;
        if (!batted) {
            b.cur = Math.min(CONFIG.bludgers.speedMax, b.cur + CONFIG.bludgers.accel * (TICK_MS / 1000));
        }
        const speed = batted ? (b.speed || CONFIG.bludgers.speedMax) : b.cur;
        b.pos = add(b.pos, scale(b.vel, speed * (TICK_MS / 1000)));
        if (!insideEnvelope(b.pos)) { b.pos = add(CENTRE, v(0, 0, 2500)); b.speedUntil = 0; }

        // Tested against EVERY seat, not just the one it was homing at — a bludger batted across the
        // pitch should hit whoever it reaches, and the immunity keeps it off the batter meanwhile.
        for (const seat of seats()) {
            if (!seat.lastPos) continue;
            if (b.immuneUntil && now < b.immuneUntil && seat.player.id === b.immuneTo) continue;
            if (dist(b.pos, seat.lastPos) > CONFIG.bludgers.hitRadius) continue;
            knock(seat, now);
            // RETREAT, rather than recoil and re-home. Nudging it back a few metres and letting it
            // steer straight back made it orbit its victim at full speed — landing no further hits,
            // because knock is inside their stun window, so it just circled them. It now flies off
            // the way it came for a beat and cannot re-target that player until their stun ends.
            b.targetId = null;
            b.vel = norm(sub(b.pos, seat.lastPos));
            b.speed = CONFIG.bludgers.retreatSpeed || CONFIG.bludgers.speedMax;
            b.cur = CONFIG.bludgers.speedMin;
            b.speedUntil = now + (CONFIG.bludgers.retreatMs || 1500);
            b.immuneTo = seat.player.id;
            b.immuneUntil = now + (CONFIG.bludgers.hitImmuneMs || 5000);
            break;
        }
    }
    for (const b of S.bludgers) {
        if (b.obj) { try { b.obj.position = new Vector3(b.pos.x, b.pos.y, b.pos.z); } catch (_) {} }
    }
}

/** A knock is animation plus a control lock. No damage call, no dismount, nothing that writes a save. */
function knock(seat, now) {
    const until = S.stunned.get(seat.player.id) || 0;
    if (now < until) return;
    S.stunned.set(seat.player.id, now + (CONFIG.bludgers.hitImmuneMs || 5000));
    if (S.ball.carrier === seat.player.id) dropBall("bludger");
    sfxAt(CONFIG.bludgers.swingHit, seat.lastPos);
    try { seat.player.emit("quidditch:knock", JSON.stringify({ ms: CONFIG.bludgers.stunMs })); } catch (_) {}
    pushStunCard(seat, now);
}

// ---------------------------------------------------------------- leaderboard

async function recordLeaderboard(seat, kind) {
    if (!seat) return;
    const character = Core.characters.active(seat.player);
    if (!character) return;
    const key = `${RESOURCE}:career`;
    let row = await Core.metadata.getCharacter(character.id, key) || {};
    if (!row || typeof row !== "object" || Array.isArray(row)) row = {};
    row[kind] = (row[kind] || 0) + 1;
    await Core.metadata.setCharacter(character.id, key, row);
}

// ---------------------------------------------------------------- lobby

/**
 * The pre-match lobby.
 *
 * Sides and positions have to be agreed BEFORE a match, and the old path swept up whoever was
 * connected and dealt roles round-robin — fine alone, meaningless with people. A referee calls it,
 * everyone claims an open slot on either side, and the referee starts when the teams look right.
 *
 * The join clock is a default, not a rule. It exists so a called match cannot sit open forever, and
 * the referee can always start early.
 */
let LOBBY = null;

const LOBBY_ID = () => (CONFIG.lobby && CONFIG.lobby.panelId) || "quidditch:lobby";
const lineup = () => (CONFIG.lobby && CONFIG.lobby.lineup) || { chaser: 3, beater: 2, keeper: 1, seeker: 1 };
const lobbyTeams = () => (LOBBY && LOBBY.teams) || (CONFIG.lobby && CONFIG.lobby.teams)
    || ["gryffindor", "slytherin"];

/**
 * A fixture is between two houses, so it is only called TO those two houses. Everyone else has no
 * business in the lobby and would only be told about a match they cannot join.
 *
 * The referee is the exception: they may be neither house, and somebody has to be able to start it.
 */
function lobbyEligible(player) {
    if (!LOBBY) return false;
    if (LOBBY.ffa || player.id === LOBBY.refereeId) return true;
    const house = playerHouse(player);
    return !!house && LOBBY.teams.includes(house);
}

/** The side a player may claim on — their own house, and nothing else. */
function lobbySideFor(player) {
    if (!LOBBY) return null;
    // In a free-for-all there is no house to play for, so every side is yours to pick from. `true`
    // rather than a house name: callers test it for truthiness and compare only when it is a string.
    if (LOBBY.ffa) return true;
    const house = playerHouse(player);
    return house && LOBBY.teams.includes(house) ? house : null;
}
const cap1 = (s) => String(s || "").replace(/^./, (c) => c.toUpperCase());

function openLobby(mode, referee, teamA, teamB, ffa) {
    if (S) { referee.sendChat("A match is already running."); return; }
    if (LOBBY) { referee.sendChat("A match has already been called."); return; }
    const spec = CONFIG.modes[mode];
    if (!spec) { referee.sendChat(`Unknown mode: ${mode}`); return; }

    const fallback = (CONFIG.lobby && CONFIG.lobby.teams) || ["gryffindor", "slytherin"];
    const a = HOUSES.includes(String(teamA || "").toLowerCase()) ? String(teamA).toLowerCase() : fallback[0];
    const b = HOUSES.includes(String(teamB || "").toLowerCase()) ? String(teamB).toLowerCase() : fallback[1];
    if (a === b) { referee.sendChat("A house cannot play itself."); return; }

    const lobby = LOBBY = {
        mode,
        teams: [a, b],
        ffa: !!ffa,
        refereeId: referee.id,
        endsAt: Date.now() + ((CONFIG.lobby && CONFIG.lobby.joinSeconds) || 120) * 1000,
        picks: new Map(),   // playerId -> { team, role }
        activitySessionId: null,
    };

    lobby.activityPromise = Activities.sessions.create(referee, ACTIVITY_ID, {
        title: ffa ? `${spec.label} — open` : `${cap1(a)} vs ${cap1(b)}`,
        visibility: ffa ? "public" : "unlisted",
        metadata: { mode, teams: [a, b], ffa: !!ffa },
        lobbyTtlSeconds: (CONFIG.lobby && CONFIG.lobby.joinSeconds) || 120,
    }).then((session) => {
        if (LOBBY === lobby) lobby.activitySessionId = session.id;
        else void Activities.sessions.cancel(session.id, { resource: RESOURCE, reason: "lobby already closed" });
        return session;
    }).catch((error) => logger.warn(`Could not mirror lobby into hmp-activities: ${error}`));

    // Told only to the two houses playing. announce() would reach the whole session, which is not
    // what a fixture between two houses means. A small unfocused card, not the picker: most of the
    // people told are busy with something else, and the call has to be something they can ignore.
    let called = 0;
    for (const p of PlayerManager.getAll()) {
        if (!lobbyEligible(p)) continue;
        ++called;
        const what = ffa ? `${spec.label} — open to all` : `${spec.label}: ${cap1(a)} vs ${cap1(b)}`;
        try { p.sendChat(`${referee.nickname || "A referee"} has called ${what}.`); } catch (_) {}
        pushLobbyCard(p);
    }
    try { referee.sendChat(`Called ${ffa ? "open" : cap1(a) + " vs " + cap1(b)} — ${called} player(s) notified.`); } catch (_) {}
}

const lobbyJoinKey = () => String((CONFIG.lobby && CONFIG.lobby.joinKey) || "j").toLowerCase();

/** What one player's call card shows: the fixture, the time left, how full each side is, their pick. */
function lobbyCardFor(player) {
    const colours = CONFIG.houseColours || {};
    const total = Object.values(lineup()).reduce((n, count) => n + count, 0);
    const pick = LOBBY.picks.get(player.id);
    return {
        title: LOBBY.ffa ? "Open match" : `${cap1(LOBBY.teams[0])} vs ${cap1(LOBBY.teams[1])}`,
        mode: (CONFIG.modes[LOBBY.mode] || {}).label || LOBBY.mode,
        remainingMs: Math.max(0, LOBBY.endsAt - Date.now()),
        teams: LOBBY.teams.map((team) => ({
            team: cap1(team),
            colour: colours[team] || "#8a8a8a",
            filled: Object.values(slotsOf(team)).reduce((n, held) => n + held.length, 0),
            total,
        })),
        pick: pick ? `${cap1(pick.team)} ${cap1(pick.role)}` : null,
        referee: player.id === LOBBY.refereeId,
        canPlay: !!lobbySideFor(player),
        key: lobbyJoinKey().toUpperCase(),
    };
}

function pushLobbyCard(player) {
    if (!LOBBY || !lobbyEligible(player)) return;
    try { player.emit("quidditch:lobbyCard", JSON.stringify(lobbyCardFor(player))); } catch (_) {}
}

// Every eligible card, after anything that changes what they show: a pick, a leave, a departure.
function pushLobbyCards() {
    for (const p of PlayerManager.getAll()) pushLobbyCard(p);
}

function closeLobby(reason, preserveActivity) {
    if (!LOBBY) return;
    const activitySessionId = LOBBY.activitySessionId;
    const audience = PlayerManager.getAll().filter((p) => lobbyEligible(p));
    for (const p of audience) {
        try { p.emit("quidditch:lobbyCard", JSON.stringify({ closed: true })); } catch (_) {}
        // Only a picker this resource opened. A full close would also cancel any other dialog they had up.
        if (lobbyMenus.has(p.id)) { try { Ui.close(p, reason || "Quidditch lobby closed"); } catch (_) {} }
        if (reason) { try { p.sendChat(reason); } catch (_) {} }
    }
    LOBBY = null;
    if (activitySessionId && !preserveActivity) {
        void Activities.sessions.cancel(activitySessionId, { resource: RESOURCE, reason: reason || "lobby closed" })
            .catch((error) => logger.warn(`Could not cancel activity lobby: ${error}`));
    }
}

const lobbyMenus = new Set();

async function showLobby(player) {
    if (!LOBBY || !lobbyEligible(player) || lobbyMenus.has(player.id)) return;
    const lobby = LOBBY;
    const mySide = lobbySideFor(player);
    const options = [];
    if (mySide) {
        for (const team of lobby.teams) {
            if (mySide !== true && mySide !== team) continue;
            const slots = slotsOf(team);
            for (const [role, maximum] of Object.entries(lineup())) {
                const filled = slots[role].length;
                if (filled >= maximum) continue;
                options.push({
                    id: `join:${team}:${role}`,
                    title: `${cap1(team)} ${cap1(role)}`,
                    description: `${maximum - filled} of ${maximum} slot(s) open`,
                });
            }
        }
    }
    options.push({ id: "pitch", title: "Go to the pitch", description: "Travel to the Quidditch pitch." });
    if (lobby.picks.has(player.id)) options.push({ id: "leave", title: "Leave lineup", tone: "warning" });
    if (player.id === lobby.refereeId) {
        options.push({ id: "start", title: "Start now", description: "Begin with the current lineup." });
        options.push({ id: "cancel", title: "Call off match", tone: "warning" });
    }

    lobbyMenus.add(player.id);
    let choice = null;
    try {
        choice = await Ui.context(player, {
            title: lobby.ffa ? "Open Quidditch match" : `${cap1(lobby.teams[0])} vs ${cap1(lobby.teams[1])}`,
            description: `${(CONFIG.modes[lobby.mode] || {}).label || lobby.mode} · choose a position`,
            options,
            canClose: true,
        });
    } catch (error) {
        logger.warn(`Lobby menu failed for ${player.id}: ${error}`);
    } finally {
        lobbyMenus.delete(player.id);
    }
    if (!choice || LOBBY !== lobby) return;
    if (choice.startsWith("join:")) {
        const [, team, role] = choice.split(":");
        claimSlot(player, team, role);
        pushLobbyCards();
        return;
    }
    if (choice === "pitch") { goToPitch(player); return; }
    if (choice === "leave") { lobby.picks.delete(player.id); pushLobbyCards(); return; }
    if (player.id !== lobby.refereeId) return;
    if (choice === "start") { void startFromLobby(true).catch((error) => logger.warn(`Lobby start failed: ${error}`)); return; }
    if (choice === "cancel") closeLobby("The match was called off.");
}

/** Who holds each slot of a team, in lineup order. */
function slotsOf(team) {
    const out = {};
    for (const role of Object.keys(lineup())) out[role] = [];
    for (const [id, pick] of LOBBY.picks) {
        if (pick.team !== team || !out[pick.role]) continue;
        const p = PlayerManager.getAll().find((x) => x.id === id);
        out[pick.role].push({ id, name: (p && p.nickname) || `#${id}` });
    }
    return out;
}

/** One team's column: its name, how many have signed, and a row per slot of the lineup. */
function teamColumn(team, viewer, mySide) {
    const slots = slotsOf(team);
    const filled = Object.values(slots).reduce((n, a) => n + a.length, 0);
    const rows = [];
    for (const [role, count] of Object.entries(lineup())) {
        for (let i = 0; i < count; i++) {
            const who = slots[role][i];
            const label = count > 1 ? `${cap1(role)} ${i + 1}` : cap1(role);
            // An open slot is CLICKABLE only on your own side. The other column is a team sheet, not
            // a menu — a listrow with no id does not fire, so this is the rule as well as the look.
            const yours = mySide === true || mySide === team;
            rows.push({ type: "listrow", props: who
                ? { title: label, sub: who.name, rightText: who.id === viewer.id ? "you" : "" }
                : (yours
                    ? { id: `join:${team}:${role}`, title: label, sub: "open", rightText: "join" }
                    : { title: label, sub: "open", rightText: "" }) });
        }
    }
    return { type: "col", props: { gap: 4 }, children: [
        { type: "eyebrow", props: { text: `${cap1(team)} — ${filled}` } },
        { type: "list", children: rows },
    ] };
}

/**
 * Wide, not tall: a team down each side and the controls between them. A fixture has two sides and
 * the panel should look like it — stacking them turns a match sheet into a scrolling list where the
 * other team is somewhere off the bottom.
 */
function lobbyTree(viewer) {
    const mine = LOBBY.picks.get(viewer.id);
    const mySide = lobbySideFor(viewer);
    const isRef = viewer.id === LOBBY.refereeId;
    const [a, b] = LOBBY.teams;

    const middle = [];
    // No packets: rp-ui rewrites a countdownTo node's text locally on its own tick.
    middle.push({ type: "text", props: { text: "", countdownTo: LOBBY.endsAt } });
    middle.push({ type: "text", props: { text: (CONFIG.modes[LOBBY.mode] || {}).label || LOBBY.mode, muted: true } });
    middle.push({ type: "spacer" });
    // Signing up and standing somewhere else is the common case: the lobby is opened from a prop,
    // and nothing about claiming a slot moves you.
    middle.push({ type: "button", props: { id: "pitch", label: "Go to the pitch" } });
    if (mine) {
        middle.push({ type: "button", props: { id: "leave", label: "Leave", variant: "ghost" } });
    }
    if (isRef) {
        middle.push({ type: "button", props: { id: "start", label: "Start now", variant: "primary" } });
        middle.push({ type: "button", props: { id: "cancel", label: "Cancel", variant: "ghost" } });
    }
    if (!mySide) {
        middle.push({ type: "text", props: { text: "Refereeing — no slot", muted: true } });
    }

    // `page` with size "wide", not a hand-rolled panel: size is a KIND of surface, not a width, and
    // rp-ui turns it into the width, height, gaps and scroll behaviour. rp-casebook's terminal is the
    // same call. Naming 75vw here would be re-deciding a house answer in a resource that has no
    // business holding an opinion about it.
    return { type: "page", props: {
        title: "QUIDDITCH",
        size: "wide",
        eyebrow: LOBBY.ffa ? "OPEN MATCH" : `${cap1(a)} VS ${cap1(b)}`,
    }, children: [
        // GRID, not row. A row lays its children out at their content width and leaves the rest of a
        // 75vw panel empty on the right; arcanum's grid is repeat(cols, 1fr), so three columns share
        // the width and the middle one actually sits in the middle.
        { type: "grid", props: { cols: 3, gap: 16 }, children: [
            teamColumn(a, viewer, mySide),
            { type: "col", props: { gap: 6 }, children: middle },
            teamColumn(b, viewer, mySide),
        ] },
    ] };
}
/** Claim a slot, giving up whatever was held before. */
function claimSlot(player, team, role) {
    if (!LOBBY) return;
    const want = lineup()[role];
    if (!want || !lobbyTeams().includes(team)) return;
    // You play for your own house. The other side is visible so the fixture reads as one, but it is
    // not yours to fill.
    const side = lobbySideFor(player);
    if (!side) { try { player.sendChat("You are not in either house."); } catch (_) {} return; }
    if (side !== true && team !== side) {
        try { player.sendChat(`You play for ${cap1(side)}.`); } catch (_) {}
        return;
    }
    const held = slotsOf(team)[role].filter((s) => s.id !== player.id);
    if (held.length >= want) { try { player.sendChat("That position is taken."); } catch (_) {} return; }
    LOBBY.picks.set(player.id, { team, role });
    try { Ui.notify(player, { title: "Quidditch", description: `${cap1(team)} ${cap1(role)} selected.`, tone: "success" }); } catch (_) {}
}

/** Everyone who claimed a slot, as the roster startSession will seat. */
function lobbyRoster() {
    const out = [];
    for (const p of PlayerManager.getAll()) {
        const pick = LOBBY.picks.get(p.id);
        if (pick) out.push({ player: p, team: pick.team, role: pick.role });
    }
    return out;
}

async function startFromLobby(byReferee) {
    if (!LOBBY) return;
    const lobby = LOBBY;
    if (lobby.starting) return;
    lobby.starting = true;
    await lobby.activityPromise;
    if (LOBBY !== lobby) return;
    const roster = lobbyRoster();
    if (!roster.length) {
        if (byReferee) announce("Nobody has picked a side yet.");
        lobby.starting = false;
        return;
    }
    const mode = LOBBY.mode;
    const thin = lobbyTeams().some((tm) =>
        roster.filter((r) => r.team === tm).length < ((CONFIG.lobby && CONFIG.lobby.wantPerTeam) || 2));
    // A warning, never a refusal: a four-a-side scratch match is still a match.
    if (thin) announce("Short sides — playing anyway.");
    // Capture the fixture BEFORE closing: the ends belong to the two houses that were called, not
    // to whichever of them happened to fill a slot.
    const fixture = LOBBY.teams.slice();
    const activitySessionId = LOBBY.activitySessionId;
    closeLobby(null, true);
    startSession(mode, null, true, roster, fixture, activitySessionId);
}

// The join clock. Starts the match if anybody claimed a slot, and quietly gives up if nobody did.
setInterval(() => {
    if (!LOBBY || Date.now() < LOBBY.endsAt) return;
    if (LOBBY.picks.size) void startFromLobby(false).catch((error) => logger.warn(`Automatic lobby start failed: ${error}`));
    else closeLobby("Nobody joined — the match was called off.");
}, 1000);

// ---------------------------------------------------------------- lifecycle

/**
 * Where a player starts. With sides assigned, each lines up in the half it defends — kicking off
 * from a shared clump in the middle makes the ends meaningless before the first pass.
 */
function pitchSpawn(index, team) {
    const spread = 1200;
    const row = Math.floor(index / 4) * 900;
    const end = S && S.defends && team && S.defends[team];
    const z = DECK_Z + (P.spawnHeight || 0);
    if (!end) return v(CENTRE.x - 3000 + row, CENTRE.y + (index % 4) * spread - spread * 1.5, z);
    const g = Object.assign({}, P.hoopGeometry, TUNE);
    const a = (g.axisDeg * Math.PI) / 180;
    const along = v(Math.cos(a), Math.sin(a), 0);
    const across = v(-Math.sin(a), Math.cos(a), 0);
    const back = add(CENTRE, scale(along, end * (g.goalDistance * 0.55)));
    const lateral = (index % 4) * spread - spread * 1.5;
    const flat = add(add(back, scale(across, lateral)), scale(along, end * row * 0.5));
    return v(flat.x, flat.y, z);
}

/**
 * Everything a seat needs to start playing: a broom, a place to stand, the brief its client
 * builds the pitch from, and its HUD.
 *
 * ONE copy, called by both kickoff and rejoin. Two copies of this would drift, and the drift
 * would look like 'rejoining works but the ball does not attach to your hand' rather than like
 * a missing line.
 *
 * One try/catch around all of it once cost an entire session: the broom grant threw, and the
 * teleport and the brief died with it while the snitch kept broadcasting from another path.
 * Independent steps get independent failures, and failures get logged.
 */
/** Names are the only handle that survives a reconnect. Lower-cased so case drift cannot lose a seat. */
const nameKey = (player) => String((player && player.nickname) || "").trim().toLowerCase();

/** Sides in play: the fixture's if there is one, otherwise whoever is actually seated. */
function sidesNow() {
    if (S && S.defends) return Object.keys(S.defends);
    return [...new Set(seats().map((x) => x.team).filter(Boolean))];
}

/** Drop holds that have run out, so one abandoned seat cannot block a side for the whole match. */
function pruneVacated() {
    if (!S) return;
    const now = Date.now();
    for (const [key, held] of S.vacated) if (held.until <= now) S.vacated.delete(key);
}

/** The first position on this side that is neither filled nor being held, or null. */
function openRole(team) {
    const want = lineup();
    const taken = {};
    for (const seat of seats()) if (seat.team === team) taken[seat.role] = (taken[seat.role] || 0) + 1;
    for (const held of S.vacated.values()) if (held.team === team) taken[held.role] = (taken[held.role] || 0) + 1;
    for (const role of Object.keys(want)) if ((taken[role] || 0) < want[role]) return role;
    return null;
}

/**
 * Take a seat in a session that is already running.
 *
 * A returning player gets their OWN seat back -- same side, same position, same goals scored --
 * because losing those to a crash is the thing this exists to stop. Everyone else takes an open
 * slot: their own house if it is playing and has room, otherwise the shorter side.
 */
function joinSession(player) {
    // A CALLED match is a lobby, not a session: `S` does not exist until it starts. Asking to join
    // one is asking for the position picker, so hand over the panel rather than the flat denial
    // this used to give -- "No match is running" is a lie when somebody just called one.
    if (!S) {
        if (!LOBBY) { try { player.sendChat("No match is running. /quidditch call <house> <house>"); } catch (_) {} return false; }
        if (!lobbyEligible(player)) {
            // Silence here is the expensive kind: the panel simply never appears and nothing says why.
            const who = LOBBY.teams.map(cap1).join(" vs ");
            try { player.sendChat(`This match is ${who}. You are not in either house.`); } catch (_) {}
            return false;
        }
        showLobby(player);
        return false;
    }
    if (S.players.has(player.id)) return false;
    pruneVacated();

    const key = nameKey(player);
    const held = S.vacated.get(key);
    let team = held && held.team;
    let role = held && held.role;

    if (!held) {
        const sides = sidesNow();
        if (!sides.length) { try { player.sendChat("This match has no sides to join."); } catch (_) {} return false; }
        const mine = playerHouse(player);
        // Your own house first if it is playing, then the shorter side -- joining the side that is
        // already winning on numbers is nobody's idea of fair.
        const order = sides.includes(mine)
            ? [mine, ...sides.filter((x) => x !== mine)]
            : [...sides].sort((a, b) => seats().filter((x) => x.team === a).length
                                       - seats().filter((x) => x.team === b).length);
        for (const side of order) {
            const free = openRole(side);
            if (free) { team = side; role = free; break; }
        }
        if (!team) {
            try { player.sendChat("Every position is taken."); } catch (_) {} return false;
        }
    }

    const seat = {
        player, team, role,
        lastPos: null,
        // Their match, not a new one: a crash should not wipe the goals they already scored.
        stats: (held && held.stats) || { goals: 0, snitch: 0 },
    };
    S.players.set(player.id, seat);
    S.vacated.delete(key);
    if (S.activitySessionId) {
        void Activities.sessions.join(player, S.activitySessionId)
            .catch((error) => logger.warn(`Could not add ${player.id} to activity session: ${error}`));
    }

    briefSeat(seat, S.players.size - 1);
    pushScore();            // everyone: the bar's sides can change when a seat fills
    announce(`${player.nickname || "A player"} ${held ? "returns" : "joins"} for ${cap1(team)} at ${role}.`);
    return true;
}

/**
 * Do they already carry one? InventoryItem's field is `itemId`, not `id` -- filtering on the wrong
 * name silently counts zero of everything, which here would read as 'they have no broom' forever
 * and hand out a fresh one every single match.
 */
function hasBroom(player) {
    try {
        return (Inventory.native.list(player) || [])
            .some((row) => row.itemId === CONFIG.broomItem && (row.count || 0) > 0);
    }
    catch (_) { return false; }   // unreadable inventory: grant, since a spare beats none
}

/** On the deck at the centre, fanned a little by id so a crowd does not arrive inside itself. */
function pitchArrival(player) {
    const lane = ((player && player.id) || 0) % 5;
    return v(CENTRE.x + (lane - 2) * 300, CENTRE.y, DECK_Z + (P.spawnHeight || 0));
}

/** Take me there. The lobby's button and /quidditch pitch are the same call. */
function goToPitch(player) {
    const at = pitchArrival(player);
    try { player.teleport(at.x, at.y, at.z); }
    catch (err) { console.error(`[QUIDDITCH] teleport to pitch failed for ${player.id}: ${err}`); return false; }
    if (!hasBroom(player)) {
        void Inventory.native.give(player, CONFIG.broomItem, 1)
            .catch((error) => logger.warn(`Broom grant failed for ${player.id}: ${error}`));
    }
    try { player.emit("quidditch:notice", JSON.stringify({ text: "The pitch. Mount your broom to fly." })); } catch (_) {}
    return true;
}

function briefSeat(seat, i) {
    const spawn = pitchSpawn(i, seat.team);
    const step = (what, fn) => {
        try { fn(); return true; }
        catch (err) { console.error(`[QUIDDITCH] ${what} failed for ${seat.player.id}: ${err}`); return false; }
    };

    // One broom per player, not one per match. Granting unconditionally handed out a fresh broom
    // every kickoff and the resource never takes any of them back.
    step("broom grant", () => {
        if (!hasBroom(seat.player)) {
            void Inventory.native.give(seat.player, CONFIG.broomItem, 1)
                .catch((error) => logger.warn(`Broom grant failed for ${seat.player.id}: ${error}`));
        }
    });
    step("teleport", () => seat.player.teleport(spawn.x, spawn.y, spawn.z));
    const briefed = step("setup", () => seat.player.emit("quidditch:setup", JSON.stringify({
        mode: S.mode,
        playerId: seat.player.id,
        role: seat.role,
        team: seat.team,
        centre: CENTRE,
        ball: CONFIG.ball,
        ballId: S.ball.obj ? S.ball.obj.id : 0,   // the quaffle's WorldObject, so a carrier knows it holds it
        bludgers: CONFIG.bludgers,
        // Beaters carry the bat, and now they are the only ones who may use it.
        bat: seat.role === "beater" ? batFor(CONFIG.bludgers.bat) : "",
        batSocket: CONFIG.bludgers.batSocket || "WandSocket",
        batOffset: CONFIG.bludgers.batOffset || {},
        unlockCasting: !!CONFIG.unlockMountedCasting,
        liftLimits: !!CONFIG.liftFlightLimits,
        ceiling: CENTRE.z + P.envelope.up,
    })));
    if (!briefed) {
        try { seat.player.sendChat("Quidditch: could not brief your client — see the server log."); } catch (_) {}
    }
    step("hud", () => pushHud(seat));
}
function startSession(mode, starter, solo, roster, fixture, activitySessionId) {
    const spec = CONFIG.modes[mode];
    if (!spec) { starter.sendChat(`Unknown mode: ${mode}`); return; }
    if (S) {
        starter.sendChat("A session is already running.");
        try { starter.emit("quidditch:notice", JSON.stringify({ text: "A session is already running — Stop it first." })); } catch (_) {}
        return;
    }

    const lineupRoster = roster || null;
    const connected = PlayerManager.getAll();
    if (!solo && connected.length < (spec.minPlayers || 1)) {
        starter.sendChat(`${spec.label} needs ${spec.minPlayers} player(s) — add "solo" to force it: /quidditch start ${mode} solo`);
        try { starter.emit("quidditch:notice", JSON.stringify({ text: `${spec.label} needs ${spec.minPlayers} players. Turn Solo on.` })); } catch (_) {}
        return;
    }

    S = freshSession(mode);
    S.activitySessionId = activitySessionId || null;
    // Native enemies would wander onto the pitch. The policy is server-wide, so endSession puts it back.
    try {
        if (FoundationWorld.policy.current().nativeEncounters) {
            FoundationWorld.policy.set({ nativeEncounters: false });
            encountersSuppressed = true;
        }
    } catch (error) { logger.warn(`Could not suppress native encounters: ${error}`); }
    // A lobby roster already carries team and role; without one, fall back to seating whoever is
    // connected, which is what solo testing needs.
    const seating = lineupRoster
        ? lineupRoster.map((r) => ({ player: r.player, team: r.team, role: r.role }))
        : connected.map((player) => ({ player, team: null, role: null }));
    seating.forEach((entry, i) => {
        const player = entry.player;
        const seat = {
            player,
            // A lobby pick wins outright — it is what the players agreed. Otherwise: an explicit
            // /quidditch team, then their real house, then a round-robin for Unaffiliated characters.
            team: entry.team || pendingTeams.get(player.id) || playerHouse(player)
                || HOUSES[i % (mode === "match" ? 2 : HOUSES.length)],
            role: entry.role || pendingRoles.get(player.id)
                || (mode === "snitchHunt" ? "seeker" : CONFIG.roles[i % CONFIG.roles.length]),
            lastPos: null,
            stats: { goals: 0, snitch: 0 },   // this match only; the store keeps the career totals
        };
        S.players.set(player.id, seat);
    });

    // hmp-activities owns discovery/exclusivity and lifecycle. The gameplay simulation remains
    // authoritative here, while the shared activity record mirrors its participants and state.
    void (async () => {
        let id = S && S.activitySessionId;
        if (!id && starter) {
            const activity = await Activities.sessions.create(starter, ACTIVITY_ID, {
                title: `${spec.label} session`, visibility: "unlisted", metadata: { mode },
            });
            id = activity.id;
            if (S) S.activitySessionId = id;
        }
        if (!id) return;
        const current = Activities.sessions.get(id);
        const joined = new Set((current && current.participants || []).map((p) => p.playerId));
        for (const entry of seating) {
            if (!joined.has(entry.player.id)) {
                try { await Activities.sessions.join(entry.player, id); } catch (error) { logger.warn(`Activity join failed for ${entry.player.id}: ${error}`); }
            }
        }
        await Activities.sessions.start(id, { resource: RESOURCE, actor: starter || undefined, reason: "match started" });
    })().catch((error) => logger.warn(`Could not start hmp-activities session: ${error}`));

    // A match needs two sides, and real houses do not guarantee that — six Gryffindors is not a
    // fixture. Only reassign when the roster genuinely collapsed onto one house, and never override
    // someone who picked a side explicitly.
    //
    // Two SIDES need two PLAYERS. One seat is not a collapsed roster, it is one person, and there
    // is nobody to split them from -- but this fired anyway and overwrote their real house with
    // HOUSES[0]. Catch the snitch as a Hufflepuff, and Gryffindor was announced.
    //
    // And when it does fire it splits along the FIXTURE. A called Hufflepuff-vs-Slytherin match
    // that everyone turned up to in the same robes is still that fixture; sorting those players
    // into Gryffindor and Slytherin because that is the order HOUSES happens to be written in
    // renames the match out from under the people who called it.
    const called = fixture && fixture.length === 2 && fixture[0] !== fixture[1] ? fixture : HOUSES;
    if (mode === "match" && seats().length > 1 && new Set(seats().map((s) => s.team)).size < 2) {
        seats().forEach((seat, i) => {
            if (!pendingTeams.has(seat.player.id)) seat.team = called[i % 2];
        });
        announce(`Everyone sorted into one house — split into ${cap1(called[0])} and ${cap1(called[1])}.`);
    }

    {
        // Count is the switch, not the mode. Bludgers were gated to `match`, which needs two
        // players, so in practice they had never been in play at all.
        const nBludgers = mode === "practice" ? 0 : (bludgerCount ?? CONFIG.bludgers.count);
        for (let i = 0; i < nBludgers; i++) {
            S.bludgers.push({ pos: add(CENTRE, v(0, 0, 2500)), vel: v(1, 0, 0), targetId: null });
        }
        S.bludgers.forEach(placeBludger);
    }
    S.ball.obj = spawnQuaffle(QUAFFLE_KEY, S.ball.pos);
    placeHoops();

    // One try/catch around all of this once cost an entire session: the broom grant threw, and the
    // teleport and the setup brief died with it while the snitch kept broadcasting from another
    // path. Independent steps get independent failures, and failures get logged.
    // Armed BEFORE the briefs go out. A mode that starts with the snitch already out then carries
    // `snitch: true` in its setup payload and each client spawns it once from there; arming after
    // meant the payload said there was none and a second event had to put it back.
    if (S.mode !== "practice") {
        const after = Number(spec.releaseAfterSec ?? CONFIG.snitch.releaseAfterSec ?? 0) || 0;
        if (after <= 0) releaseSnitch();
        else {
            S.snitch.releaseAt = S.startedAt + after * 1000;
            announce(`The Snitch is released in ${Math.round(after / 60)} minute(s).`);
        }
    }

    seats().forEach(briefSeat);

    // Which side keeps which end. A hoop only means something once somebody owns it.
    //
    // The FIXTURE decides this when there is one, not who turned up: a called Gryffindor-vs-Slytherin
    // match has two ends even if only Gryffindor filled a slot. Falling back to the distinct teams
    // actually seated left a solo session with one side, no ends, and therefore no banners — which is
    // exactly how this went unnoticed.
    {
        const seated = [...new Set(seats().map((s) => s.team))];
        let pair = null;
        if (fixture && fixture.length === 2 && fixture[0] !== fixture[1]) pair = fixture;
        else if (seated.length === 2) pair = seated;
        else if (seated.length === 1) {
            // One side on the pitch still gets an end to attack, or a solo test cannot score at all.
            const other = HOUSES.find((h) => h !== seated[0]);
            if (other) pair = [seated[0], other];
        }
        if (pair) {
            S.defends = { [pair[0]]: 1, [pair[1]]: -1 };
            announce(`${cap1(pair[0])} defend one end, ${cap1(pair[1])} the other.`);
        }
        else {
            console.log(`[QUIDDITCH] no ends assigned (${seated.length} side(s)) — every hoop scores`);
        }
    }

    pushBanners();
    startAmbience();
    announce(`${spec.label} — begin!`);
    publishScoreboard();
    pushScore();   // after the ends are assigned, so left and right match the pitch
    pendingTeams.clear();
    pendingRoles.clear();
}

/**
 * End the session, but let the moment that ended it play first.
 *
 * Catching the snitch used to tear everything down in the same tick that announced it: the banner,
 * the final score and the snitch despawn all landed together, and teardown destroyed the client's
 * views a few milliseconds into the biggest banner in the game. A celebration window fixes that at
 * the source rather than making the overlay outlive its session.
 *
 * The world stays up during the window and only scoring stops — see the tick.
 */
function finishSession(reason, delayMs) {
    if (!S || S.ending) return;
    if (!delayMs) { endSession(reason); return; }
    S.ending = true;
    // A catch has already cheered a beat ago; anything else ending has not, and a match that just
    // runs out of clock deserves the same crowd as one that is won outright.
    if (reason !== "snitch") sfxAll(SFX.victory);
    sfxAll(SFX.finish);
    broadcast("quidditch:results", resultsPayload(reason));
    setTimeout(() => { if (S && S.ending) endSession(reason); }, delayMs);
}

/** Final score plus who did what. Career totals live in the store; these are this match only. */
function resultsPayload(reason) {
    const goalPts = CONFIG.scoring.goal, snitchPts = CONFIG.snitch.points;
    const players = seats().map((s) => {
        const st = s.stats || { goals: 0, snitch: 0 };
        return {
            name: s.player.nickname || `#${s.player.id}`,
            team: s.team, role: s.role, goals: st.goals, snitch: st.snitch,
            points: st.goals * goalPts + st.snitch * snitchPts,
        };
    }).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));

    // Only houses that actually fielded someone — an empty Ravenclaw row on a solo hunt is noise.
    const played = new Set(seats().map((s) => s.team));
    const score = Object.entries(S.score)
        .filter(([house, pts]) => played.has(house) || pts > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([house, pts]) => ({ house, points: pts }));

    return {
        reason, mode: (CONFIG.modes[S.mode] || {}).label || S.mode,
        winner: score.length && score[0].points > 0 ? score[0].house : null,
        durationSec: Math.round((Date.now() - S.startedAt) / 1000),
        score, players,
    };
}

// Only what this resource switched off is switched back on: a server that already ran without native
// encounters keeps running without them.
let encountersSuppressed = false;

function endSession(reason) {
    if (!S) return;
    const activitySessionId = S.activitySessionId;
    const activityResult = resultsPayload(reason);
    if (encountersSuppressed) {
        encountersSuppressed = false;
        try { FoundationWorld.policy.set({ nativeEncounters: true }); }
        catch (error) { logger.warn(`Could not restore native encounters: ${error}`); }
    }
    for (const id of [...stunCards.keys()]) clearStunCard(id);
    for (const h of fumbleCards.values()) clearInterval(h);
    fumbleCards.clear();
    stopAmbience();
    placeBanners([]);
    clearBludgers();
    clearQuaffle();
    clearHoopObjects();
    clearSnitch();
    S.finished = true;
    const winner = Object.entries(S.score).sort((a, b) => b[1] - a[1])[0];
    announce(`Session over (${reason}). ${winner && winner[1] > 0 ? `${winner[0]} take it with ${winner[1]}.` : "No score."}`);
    for (const seat of seats()) {
        try { seat.player.emit("quidditch:teardown", JSON.stringify({})); } catch (_) {}
        if (Events.listenerCount("rp:ui:hud:clear") > 0) {
            try { Events.emit("rp:ui:hud:clear", seat.player, "quidditch"); } catch (_) {}
        }
    }
    S = null;
    FoundationAudio.sounds.release(AUDIO_OWNER);
    clearMatchBlips();
    if (activitySessionId) {
        const terminal = reason === "snitch" || reason === "time";
        const operation = terminal
            ? Activities.sessions.complete(activitySessionId, activityResult, { resource: RESOURCE, reason })
            : Activities.sessions.cancel(activitySessionId, { resource: RESOURCE, reason });
        void operation.catch((error) => logger.warn(`Could not close hmp-activities session: ${error}`));
    }
    publishScoreboard();
}

// The catch bar rides its own beat rather than the 500 ms HUD refresh — a 1.2 s hold needs to be
// seen filling, and the grace decay needs to be seen draining when you drift off.
let catchCardOn = null;   // playerId currently showing the bar

function pushCatchBar() {
    if (Events.listenerCount("rp:ui:hud") === 0 || !S) return;
    const sn = S.snitch;
    const holder = sn.holder ? S.players.get(sn.holder) : null;

    if (catchCardOn && (!holder || catchCardOn !== sn.holder)) {
        const stale = S.players.get(catchCardOn);
        if (stale) { try { Events.emit("rp:ui:hud", stale.player, "quidditch:catch", null); } catch (_) {} }
        catchCardOn = null;
    }
    if (!holder) return;

    const need = CONFIG.snitch.catchHoldMs || 1200;
    const held = clamp(sn.heldMs, 0, need);
    try {
        Events.emit("rp:ui:hud", holder.player, "quidditch:catch", {
            kind: "meter", label: "Catching", value: Math.round(held), max: need, order: 25,
            tone: "gold", detail: `${((need - held) / 1000).toFixed(1)}s`,
        });
        catchCardOn = sn.holder;
    } catch (_) {}
}

function clearCatchBar() {
    if (!catchCardOn || !S) { catchCardOn = null; return; }
    const seat = S.players.get(catchCardOn);
    if (seat) { try { Events.emit("rp:ui:hud", seat.player, "quidditch:catch", null); } catch (_) {} }
    catchCardOn = null;
}

/**
 * What to press, while carrying. Pass and Shoot have no world anchor — they are things you do with
 * the ball, not things you walk up to — so they cannot ride a world plate the way pickup does, and
 * the HUD is the only surface left. The key is not named: rp-ui owns the keymap and the wheel key is
 * configurable, so spelling one out here would go stale silently.
 *
 * Edge-triggered. `pushHud` runs twice a second and re-emitting an unchanged card that often is
 * pointless work in the HUD arbiter.
 */
/** A bat id from the config list, or the configured default. Unknown ids fall back rather than throw. */
function batFor(id) {
    const list = (CONFIG.bludgers && CONFIG.bludgers.bats) || [];
    const want = id || CONFIG.bludgers.bat;
    // Case-insensitive: the chat command lower-cases its argument, so a camelCase id like `shopA`
    // would never match itself and every shop bat read as an unknown name.
    const key = String(want || "").toLowerCase();
    const hit = list.find((b) => String(b.id).toLowerCase() === key) || list[0];
    return hit ? hit.mesh : "";
}

function pushBat(player, id) {
    const b = CONFIG.bludgers || {};
    try {
        player.emit("quidditch:bat", JSON.stringify({
            mesh: id === "" ? "" : batFor(id), socket: b.batSocket, offset: b.batOffset || {},
        }));
    } catch (_) {}
}

/**
 * A bludger hit takes your broom input for a moment, and until now nothing said so — control simply
 * stopped answering, which reads as a hitch or a hang rather than a hit. Rides its own beat like the
 * catch bar, because a 1.8 s window has to be seen draining to be understood.
 */
let stunCards = new Map();   // playerId -> interval handle

function pushStunCard(seat, now) {
    if (Events.listenerCount("rp:ui:hud") === 0) return;
    const id = seat.player.id;
    const until = now + CONFIG.bludgers.stunMs;
    const draw = () => {
        const left = until - Date.now();
        if (left <= 0 || !S) { clearStunCard(id); return; }
        try {
            Events.emit("rp:ui:hud", seat.player, "quidditch:stun", {
                kind: "meter", label: "Knocked", value: Math.round(left), max: CONFIG.bludgers.stunMs,
                order: 22, tone: "red", detail: `${(left / 1000).toFixed(1)}s`,
            });
        } catch (_) {}
    };
    const prev = stunCards.get(id);
    if (prev) clearInterval(prev);
    stunCards.set(id, setInterval(draw, 100));
    draw();
}

function clearStunCard(id) {
    const h = stunCards.get(id);
    if (h) clearInterval(h);
    stunCards.delete(id);
    const seat = S && S.players.get(id);
    if (seat) { try { Events.emit("rp:ui:hud", seat.player, "quidditch:stun", null); } catch (_) {} }
}

function pushCarryCard(seat) {
    if (Events.listenerCount("rp:ui:hud") === 0 || !S) return;
    const carrying = S.ball.carrier === seat.player.id;
    if (carrying === !!seat.carryCard) return;
    seat.carryCard = carrying;
    try {
        Events.emit("rp:ui:hud", seat.player, "quidditch:quaffle", carrying
            ? { kind: "badge", label: "Quaffle", tone: "gold", order: 15,
                detail: `${PASS_KEY.toUpperCase()} pass · ${SHOOT_KEY.toUpperCase()} shoot` }
            : null);
    } catch (_) {}
}

function pushHud(seat) {
    if (Events.listenerCount("rp:ui:hud") === 0 || !S) return;
    pushCarryCard(seat);
    try {
        Events.emit("rp:ui:hud", seat.player, "quidditch:score",
            { kind: "badge", label: `${S.score[seat.team] || 0}`, tone: "gold", order: 10, detail: seat.team });
        Events.emit("rp:ui:hud", seat.player, "quidditch:clock",
            { kind: "timer", label: CONFIG.modes[S.mode].label, startedAt: S.startedAt, endsAt: S.endsAt, order: 20 });
        // Before release there is nothing to be near, so the bar is a clock instead. Without this
        // the HUD says nothing at all for five minutes and the snitch reads as broken.
        if (S.mode !== "practice" && !S.snitch.releasedAt && S.snitch.releaseAt) {
            Events.emit("rp:ui:hud", seat.player, "quidditch:snitch",
                { kind: "timer", label: "Snitch released", startedAt: S.startedAt,
                  endsAt: S.snitch.releaseAt, order: 30 });
        }
        if (S.mode !== "practice" && S.snitch.releasedAt && S.snitch.pos && seat.lastPos && !S.snitch.hidden) {
            // Proximity as a percentage, closing over the last `hudRange` metres. The bar used to
            // carry raw inverted centimetres, which is not a number anyone can read.
            const d = catchDistance(seat);
            const range = (CONFIG.snitch.hudRange || 100) * 100;
            const close = Math.round(Math.max(0, 1 - d / range) * 100);
            const now = Date.now();
            const worn = Math.round(snitchWear(now) * 100);
            const inRange = d <= catchRadiusNow(now);
            Events.emit("rp:ui:hud", seat.player, "quidditch:snitch", {
                kind: "meter", label: "Snitch", value: close, max: 100, order: 30,
                detail: `${Math.round(d / 100)} m${inRange ? " — CATCHING" : (worn > 5 ? ` · tiring ${worn}%` : "")}`,
                tone: inRange ? "gold" : undefined,
            });
        }
    } catch (_) {}
}

// ---------------------------------------------------------------- tick

let hudBeat = 0;

setInterval(() => {
    if (!S) return;
    const now = Date.now();

    for (const seat of seats()) {
        try { const p = seat.player.position; seat.lastPos = v(p.x, p.y, p.z); } catch (_) {}
    }

    // Celebration window: the pitch stays exactly as it is and the HUD keeps showing the final
    // score, but nothing can score again — a goal landing during the snitch banner would be absurd.
    if (S.ending) {
        if (++hudBeat % 10 === 0) { for (const seat of seats()) pushHud(seat); }
        return;
    }

    // Any step can end the session under us — catching the snitch does exactly that — so the
    // session is re-checked between them rather than assumed to survive the tick.
    if (S.mode !== "practice") {
        // Released from the tick, not a setTimeout: a timer would keep its own reference to a
        // session that may already have ended.
        if (!S.snitch.releasedAt && S.snitch.releaseAt && now >= S.snitch.releaseAt) releaseSnitch();
        if (S.snitch.releasedAt) { stepSnitch(now); if (!S) return; pushCatchBar(); }
    }
    if (!S) return;
    stepBall();
    if (!S) return;
    stepBludgers(now);
    if (!S) return;

    // Poke rp-ui when a player CROSSES the reach boundary, so the offer (and the hotkey bind behind
    // it) rebuilds the moment the ball comes within range instead of up to 750 ms later.
    //
    // Edge-triggered, and that is not a micro-optimisation. rp-ui keeps the last 40 offers and a
    // client's held hotkey carries the seq of the build it was told about; it only re-learns that
    // seq when the map changes or every 7.5 s. Poking on every tick built offers at ~7/s, which cut
    // the ring from ~30 s of history down to ~5 s — so the seq the client was holding got evicted
    // before it was reissued, and every press in that window was rejected as "not offered". A
    // continuous poke is exactly the abuse the 40-offer ring was sized against.
    // Poke rp-ui when a player crosses into reach of ANYTHING it offers for. The wheel rebuilds
    // context on a 750 ms poll, and a bludger closing at speedMax covers ~19 m in that window —
    // wider than the swing reach itself, so without this the Swing offer could arrive after the
    // bludger had already passed, exactly as the quaffle pickup did before.
    if (Events.listenerCount("rp:ui:context:poke") > 0) {
        const ballReach = (CONFIG.ball.pickupRadius || 700) * 2;
        const swingReach = (CONFIG.bludgers.swingRadius || 1400) * 1.5;
        for (const seat of seats()) {
            if (!seat.lastPos) continue;
            // Role-gated too: poking for an offer this seat can never be given spends the ring on
            // nothing, and the ring is the thing a held hotkey's seq lives in.
            const nearBall = S.ball.loose && dist(seat.lastPos, S.ball.pos) <= ballReach
                && roleAllowed(seat, CONFIG.ball.carryRoles);
            const nearBludger = roleAllowed(seat, CONFIG.bludgers.swingRoles)
                && S.bludgers.some((b) => dist(seat.lastPos, b.pos) <= swingReach);
            // Edge-triggered on EITHER, because a continuous poke starves rp-ui's 40-offer ring and
            // evicts the seq a held hotkey is carrying.
            if (nearBall === !!seat.nearBall && nearBludger === !!seat.nearBludger) continue;
            seat.nearBall = nearBall;
            seat.nearBludger = nearBludger;
            try { Events.emit("rp:ui:context:poke", seat.player); } catch (_) {}
        }
    }

    if (++hudBeat % 10 === 0) { for (const seat of seats()) pushHud(seat); syncMatchBlips(); }
    if (now >= S.endsAt) finishSession("time", CONFIG.scoring.celebrateMs ?? 14000);
}, TICK_MS);

// ---------------------------------------------------------------- client events

Events.onClient("quidditch:snitchCmd", async (player, raw) => {
    if (!(await requireManager(player))) return;
    snitchCommand(player, payload(raw));
});

// Shared by the client event and the manager's snitch controls.
function snitchCommand(player, d) {
    if (!d || !S) return;
    const sn = S.snitch;
    if (d.freeze !== undefined) {
        sn.frozen = !!d.freeze;
        announce(sn.frozen ? "Snitch held in place." : "Snitch released.");
    }
    if (d.bring) {
        const seat = seatOf(player);
        if (seat && seat.lastPos) {
            sn.pos = add(seat.lastPos, v(0, 0, 300));
            sn.target = sn.pos;
            sn.beat = 0;   // force an immediate steer so the puppet follows it there
            try { player.sendChat("Snitch brought to you."); } catch (_) {}
        }
    }
    if (d.reset) {
        sn.caught = false; sn.holder = null; sn.heldMs = 0; sn.frozen = false;
        if (sn.releasedAt && !sn.obj) {
            spawnSnitch();
            broadcast("quidditch:resnitch", { id: sn.obj ? sn.obj.id : 0 });
        }
    }
    if (d.release) releaseSnitch();
    if (d.blip !== undefined) {
        CONFIG.snitch.blip = !!d.blip;
        syncMatchBlips();
        for (const seat of seats()) {
            try { seat.player.emit("quidditch:snitchBlip", JSON.stringify({ on: CONFIG.snitch.blip })); } catch (_) {}
        }
    }
}

Events.onClient("quidditch:manageStart", async (player, raw) => {
    if (!(await requireManager(player))) return;
    const d = payload(raw);
    if (!d) return;
    if (d.stop) { endSession("manager"); return; }
    // Call opens the lobby instead of starting immediately — the referee still presses Start.
    if (d.call) { openLobby(d.mode || "match", player, d.teamA, d.teamB, !!d.ffa); return; }
    if (LOBBY) { void startFromLobby(true).catch((error) => logger.warn(`Lobby start failed: ${error}`)); return; }
    startSession(d.mode || "snitchHunt", player, !!d.solo);
});

Events.onClient("quidditch:pickup", (player) => {
    const seat = seatOf(player);
    if (!seat || !S || !S.ball.loose || !seat.lastPos) return;
    if (dist(seat.lastPos, S.ball.pos) > (CONFIG.ball.pickupRadius || 700)) return;
    if (S.stunned.get(player.id) > Date.now()) return;
    grantPossession(seat);
});

Events.onClient("quidditch:throw", (player, raw) => {
    const seat = seatOf(player);
    if (!seat || !S || S.ball.carrier !== player.id) return;
    const aim = payload(raw);
    if (!aim || typeof aim.x !== "number") return;

    // The client supplies aim only; the server re-derives the launch from its own positions and
    // clamps the speed, so a forged payload cannot produce an impossible throw.
    const from = add(seat.lastPos, v(0, 0, 60));
    const dir = norm(v(aim.x, aim.y, aim.z));
    const speed = clamp(Number(aim.speed) || CONFIG.ball.throwSpeed, 0, CONFIG.ball.throwSpeedMax);
    S.ball.carrier = null;
    S.ball.loose = true;
    S.ball.lastThrower = player.id;
    S.ball.throwFrom = from;   // the shot's release point, for the scoring-area rule
    S.ball.pos = from;
    S.ball.prev = from;
    if (S.ball.obj) {
        S.ball.obj.detach();
        S.ball.obj.setVelocity(dir.x * speed, dir.y * speed, dir.z * speed);
    }
    pushScore();
    broadcast("quidditch:ballThrow", {});
});


Events.onClient("quidditch:block", (player, raw) => {
    const seat = seatOf(player);
    if (seat && S) blockBall(seat, payload(raw));
});

Events.onClient("quidditch:swing", (player, raw) => {
    const seat = seatOf(player);
    if (seat && S) swingAt(seat, payload(raw));
});

Events.onClient("quidditch:tackle", (player) => {
    const seat = seatOf(player);
    if (seat && S) tackle(seat);
});

// ---------------------------------------------------------------- manager

/**
 * The tuning screens, on hmp-ui's live input dialogs.
 *
 * Values live HERE, not in the dialog. Each slider edit reaches the server as it happens, already
 * checked against the slider's own range, and lands in the same config box the match reads from.
 * Cancelling puts back what the dialog opened with.
 */
const MGR_TABS = [
    { id: "snitch",   label: "Snitch" },
    { id: "bludgers", label: "Bludgers" },
    { id: "keeper",   label: "Keeper" },
    { id: "bat",      label: "Bat" },
    { id: "banners",  label: "Banners" },
    { id: "hoops",    label: "Hoops" },
];

// Every slider in one table: which section it belongs to, where its value lives, and its range.
// `get` reads the live value; `set` is the only thing that knows where a number goes.
const MGR_SLIDERS = [
    { tab: "snitch", id: "catchHoldMs", label: "Catch hold", min: 200, max: 4000, step: 100, unit: "ms", box: () => CONFIG.snitch },
    { tab: "snitch", id: "catchRadius", label: "Catch radius", min: 300, max: 4000, step: 100, unit: "cm", box: () => CONFIG.snitch },
    { tab: "snitch", id: "cruiseSpeed", label: "Cruise speed", min: 200, max: 3000, step: 50, unit: "", box: () => CONFIG.snitch },
    { tab: "snitch", id: "fleeSpeed", label: "Flee speed", min: 200, max: 4000, step: 50, unit: "", box: () => CONFIG.snitch },
    { tab: "snitch", id: "graceSec", label: "Fatigue after", min: 0, max: 300, step: 5, unit: "s", box: () => CONFIG.snitch.fatigue },
    { tab: "snitch", id: "rampSec", label: "Fatigue ramp", min: 10, max: 600, step: 10, unit: "s", box: () => CONFIG.snitch.fatigue },
    { tab: "snitch", id: "floor", label: "Fatigue floor", min: 0, max: 1, step: 0.05, unit: "x", box: () => CONFIG.snitch.fatigue },
    { tab: "snitch", id: "radiusBonus", label: "Tired catch +", min: 0, max: 3000, step: 100, unit: "cm", box: () => CONFIG.snitch.fatigue },

    { tab: "bludgers", id: "scale", label: "Scale", min: 0.5, max: 6, step: 0.1, unit: "x", box: () => CONFIG.bludgers, after: pushBludgerScale },
    { tab: "bludgers", id: "speedMin", label: "Speed min", min: 200, max: 3000, step: 50, unit: "", box: () => CONFIG.bludgers },
    { tab: "bludgers", id: "speedMax", label: "Speed max", min: 400, max: 5000, step: 50, unit: "", box: () => CONFIG.bludgers },
    { tab: "bludgers", id: "accel", label: "Accel", min: 0, max: 2000, step: 50, unit: "", box: () => CONFIG.bludgers },
    { tab: "bludgers", id: "homingStrength", label: "Homing", min: 0.02, max: 1, step: 0.02, unit: "", box: () => CONFIG.bludgers },
    { tab: "bludgers", id: "hitRadius", label: "Hit radius", min: 20, max: 1200, step: 20, unit: "cm", box: () => CONFIG.bludgers },
    { tab: "bludgers", id: "stunMs", label: "Stun", min: 0, max: 12000, step: 100, unit: "ms", box: () => CONFIG.bludgers },
    { tab: "bludgers", id: "hitImmuneMs", label: "Immune for", min: 500, max: 40000, step: 500, unit: "ms", box: () => CONFIG.bludgers },
    { tab: "bludgers", id: "swingRadius", label: "Swing reach", min: 300, max: 4000, step: 100, unit: "cm", box: () => CONFIG.bludgers },
    { tab: "bludgers", id: "swingSpeed", label: "Swing power", min: 500, max: 6000, step: 100, unit: "", box: () => CONFIG.bludgers },

    { tab: "keeper", id: "scoringArea", label: "Scoring area", min: 500, max: 6000, step: 100, unit: "cm", box: () => CONFIG.keeper },
    { tab: "keeper", id: "tackleRadius", label: "Tackle reach", min: 200, max: 2500, step: 50, unit: "cm", box: () => CONFIG.keeper },
    { tab: "keeper", id: "fumbleMs", label: "Fumble for", min: 0, max: 30000, step: 500, unit: "ms", box: () => CONFIG.keeper },
    { tab: "keeper", id: "tackleStunMs", label: "Tackle stun", min: 0, max: 3000, step: 100, unit: "ms", box: () => CONFIG.keeper },
    { tab: "keeper", id: "blockRadius", label: "Block reach", min: 200, max: 3000, step: 100, unit: "cm", box: () => CONFIG.keeper },
    { tab: "keeper", id: "blockSpeed", label: "Block power", min: 500, max: 6000, step: 100, unit: "", box: () => CONFIG.keeper },
    { tab: "keeper", id: "minShotDistance", label: "Min shot", min: 0, max: 6000, step: 100, unit: "cm", box: () => CONFIG.keeper },

    { tab: "bat", id: "pitch", label: "Pitch", min: -180, max: 180, step: 5, unit: "deg", box: () => CONFIG.bludgers.batOffset, after: pushBatToAll },
    { tab: "bat", id: "yaw", label: "Yaw", min: -180, max: 180, step: 5, unit: "deg", box: () => CONFIG.bludgers.batOffset, after: pushBatToAll },
    { tab: "bat", id: "roll", label: "Roll", min: -180, max: 180, step: 5, unit: "deg", box: () => CONFIG.bludgers.batOffset, after: pushBatToAll },
    { tab: "bat", id: "x", label: "Fwd", min: -50, max: 50, step: 1, unit: "cm", box: () => CONFIG.bludgers.batOffset, after: pushBatToAll },
    { tab: "bat", id: "y", label: "Side", min: -50, max: 50, step: 1, unit: "cm", box: () => CONFIG.bludgers.batOffset, after: pushBatToAll },
    { tab: "bat", id: "z", label: "Up", min: -50, max: 50, step: 1, unit: "cm", box: () => CONFIG.bludgers.batOffset, after: pushBatToAll },
    { tab: "bat", id: "scale", label: "Scale", min: 0.2, max: 3, step: 0.1, unit: "x", box: () => CONFIG.bludgers.batOffset, after: pushBatToAll },

    { tab: "banners", id: "yaw", label: "Big yaw", min: 0, max: 350, step: 10, unit: "deg", box: () => BTUNE, dflt: bcfg, after: pushBanners },
    { tab: "banners", id: "lift", label: "Big lift", min: -2000, max: 4000, step: 50, unit: "cm", box: () => BTUNE, dflt: bcfg, after: pushBanners },
    { tab: "banners", id: "scale", label: "Big scale", min: 0.5, max: 8, step: 0.1, unit: "x", box: () => BTUNE, dflt: bcfg, after: pushBanners },
    { tab: "banners", id: "side", label: "Big side", min: -1500, max: 1500, step: 25, unit: "cm", box: () => BTUNE, dflt: bcfg, after: pushBanners },
    { tab: "banners", id: "fwd", label: "Big fwd", min: -1500, max: 1500, step: 25, unit: "cm", box: () => BTUNE, dflt: bcfg, after: pushBanners },
    { tab: "banners", id: "hoopYaw", label: "Ring yaw", min: 0, max: 350, step: 10, unit: "deg", box: () => BTUNE, dflt: bcfg, after: pushBanners },
    { tab: "banners", id: "hoopGap", label: "Ring gap", min: -1500, max: 2000, step: 20, unit: "cm", box: () => BTUNE, dflt: bcfg, after: pushBanners },
    { tab: "banners", id: "hoopScale", label: "Ring scale", min: 0.2, max: 4, step: 0.1, unit: "x", box: () => BTUNE, dflt: bcfg, after: pushBanners },
    { tab: "banners", id: "hoopSide", label: "Ring side", min: -800, max: 800, step: 10, unit: "cm", box: () => BTUNE, dflt: bcfg, after: pushBanners },
    { tab: "banners", id: "hoopFwd", label: "Ring fwd", min: -800, max: 800, step: 10, unit: "cm", box: () => BTUNE, dflt: bcfg, after: pushBanners },

    { tab: "hoops", id: "goalDistance", label: "Goal distance", min: 2000, max: 12000, step: 100, unit: "cm", box: () => TUNE, dflt: tuning, after: rebuildHoops },
    { tab: "hoops", id: "spacing", label: "Hoop spacing", min: 400, max: 4000, step: 50, unit: "cm", box: () => TUNE, dflt: tuning, after: rebuildHoops },
    { tab: "hoops", id: "axisDeg", label: "Pitch axis", min: 0, max: 180, step: 0.2, unit: "deg", box: () => TUNE, dflt: tuning, after: rebuildHoops },
    { tab: "hoops", id: "yawOffset", label: "Ring yaw +", min: 0, max: 180, step: 90, unit: "deg", box: () => TUNE, dflt: tuning, after: rebuildHoops },
];

function pushBludgerScale() {
    if (S) S.bludgers.forEach(placeBludger);
}

// Only to the seats that may actually use one. Re-pushing on a slider used to arm every player
// with a bat, including the roles that are now refused the swing it is for.
function pushBatToAll() {
    for (const seat of seats()) {
        pushBat(seat.player, roleAllowed(seat, CONFIG.bludgers.swingRoles) ? CONFIG.bludgers.bat : "");
    }
}

function rebuildHoops() {
    HOOPS = buildHoops();
    pushHoops();
}

function mgrValue(sl) {
    const box = sl.box();
    const v = box && box[sl.id];
    if (typeof v === "number") return v;
    const d = sl.dflt ? sl.dflt() : null;
    return (d && typeof d[sl.id] === "number") ? d[sl.id] : 0;
}

// hmp-ui lower-cases field names, so a slider is found again by its lower-cased id.
function mgrSlider(tab, name) {
    return MGR_SLIDERS.find((sl) => sl.tab === tab && sl.id.toLowerCase() === name);
}

function mgrApply(sl, value) {
    const box = sl.box();
    if (!box) return;
    box[sl.id] = value;
    if (sl.after) sl.after();
}

async function showTuning(player) {
    const tab = await Ui.context(player, {
        title: "Tune the pitch",
        description: "Each slider applies as you drag it. Cancel puts the section back as it was.",
        options: MGR_TABS.map((t) => ({ id: t.id, title: t.label })),
        canClose: true,
    });
    if (!tab) return;
    const sliders = MGR_SLIDERS.filter((sl) => sl.tab === tab);
    const before = sliders.map((sl) => [sl, mgrValue(sl)]);
    const fields = sliders.map((sl) => ({
        name: sl.id.toLowerCase(), label: sl.label, type: "range",
        min: sl.min, max: sl.max, step: sl.step, unit: sl.unit || undefined, default: mgrValue(sl),
    }));
    const perHoopBefore = bcfg().perHoop !== false;
    if (tab === "banners") fields.unshift({ name: "perhoop", label: "Banners under the rings", type: "checkbox", default: perHoopBefore });
    const label = (MGR_TABS.find((t) => t.id === tab) || {}).label || tab;
    const result = await Ui.input(player, {
        title: `Tune: ${label}`,
        fields,
        submitLabel: "Keep",
        cancelLabel: "Revert",
    }, {
        onChange: (name, value) => {
            if (name === "perhoop") { BTUNE.perHoop = !!value; pushBanners(); return; }
            const sl = mgrSlider(tab, name);
            if (sl && typeof value === "number") mgrApply(sl, value);
        },
    });
    if (result) return;
    // Cancelled, closed or timed out: every slider in the section goes back, touched or not.
    for (const [sl, value] of before) mgrApply(sl, value);
    if (tab === "banners") { BTUNE.perHoop = perHoopBefore; pushBanners(); }
}

async function showSnitchControls(player) {
    if (!S) return;
    const choice = await Ui.context(player, {
        title: "Snitch controls",
        description: "Freeze holds it still but keeps the catch test running — the way to tell a broken catch from a chase you cannot win.",
        options: [
            { id: "freeze", title: S.snitch.frozen ? "Release it" : "Freeze it" },
            { id: "bring", title: "Bring it to me", description: "Steers it to three metres above you." },
            { id: "release", title: "Release now", disabled: !!S.snitch.releasedAt },
            { id: "reset", title: "Reset", description: "Clears a catch in progress and respawns a caught snitch." },
            { id: "blip", title: CONFIG.snitch.blip ? "Hide its marker" : "Show its marker" },
        ],
        canClose: true,
    });
    if (!choice) return;
    if (choice === "freeze") snitchCommand(player, { freeze: !S.snitch.frozen });
    else if (choice === "bring") snitchCommand(player, { bring: true });
    else if (choice === "release") snitchCommand(player, { release: true });
    else if (choice === "reset") snitchCommand(player, { reset: true });
    else if (choice === "blip") snitchCommand(player, { blip: !CONFIG.snitch.blip });
}

async function showBludgerControls(player) {
    if (!S) return;
    const choice = await Ui.context(player, {
        title: "Bludger controls",
        options: [
            { id: "freeze", title: S.bludgersFrozen ? "Release them" : "Freeze them", description: "Frozen bludgers hold still and hit nobody." },
            { id: "blip", title: CONFIG.bludgers.blip ? "Hide their markers" : "Show their markers" },
        ],
        canClose: true,
    });
    if (!choice || !S) return;
    if (choice === "freeze") S.bludgersFrozen = !S.bludgersFrozen;
    else if (choice === "blip") { CONFIG.bludgers.blip = !CONFIG.bludgers.blip; syncMatchBlips(); }
}

async function showBatChoice(player) {
    const bats = CONFIG.bludgers.bats || [];
    const result = await Ui.input(player, {
        title: "Beater bat",
        fields: [
            { name: "bat", label: "Bat", type: "select", default: CONFIG.bludgers.bat || "none",
                options: bats.map((b) => ({ value: b.id, label: b.label || b.id })).concat([{ value: "none", label: "None" }]) },
            { name: "socket", label: "Socket", type: "text", default: CONFIG.bludgers.batSocket || "WandSocket" },
        ],
        submitLabel: "Apply",
    });
    if (!result) return;
    CONFIG.bludgers.batSocket = String(result.socket || "WandSocket");
    if (result.bat === "none") pushBat(player, "");
    else { CONFIG.bludgers.bat = String(result.bat); pushBatToAll(); }
}

let MGR_MODE = "match";
let MGR_A = "gryffindor";
let MGR_B = "slytherin";
let MGR_FFA = false;

async function showManager(player) {
    if (!(await requireManager(player))) return;
    const choice = await Ui.context(player, {
        title: "Quidditch manager",
        description: S ? `${(CONFIG.modes[S.mode] || {}).label || S.mode} is running.` : "Call or start a session.",
        options: [
            { id: "call", title: "Call a match", description: "Open a house lineup through Foundations UI." },
            { id: "start", title: "Start immediately", description: "Start a closed-test session with connected players." },
            { id: "lobby", title: "Open current lobby", disabled: !LOBBY },
            { id: "tune", title: "Tune the pitch", description: "Live sliders for the snitch, bludgers, keeper, bat, banners and hoops." },
            { id: "snitch", title: "Snitch controls", description: "Freeze, summon, release or reset the snitch.", disabled: !S },
            { id: "bludgers", title: "Bludger controls", description: "Hold the bludgers still, or toggle their markers.", disabled: !S },
            { id: "bat", title: "Beater bat", description: "Choose the bat and the socket it rides." },
            { id: "pitch", title: "Go to the pitch" },
            { id: "stop", title: "Stop session", disabled: !S, tone: "warning" },
        ],
        canClose: true,
    });
    if (!choice) return;
    if (choice === "pitch") { goToPitch(player); return; }
    if (choice === "lobby") { void showLobby(player); return; }
    if (choice === "stop") { endSession("manager"); return; }
    if (choice === "tune") { await showTuning(player); return; }
    if (choice === "snitch") { await showSnitchControls(player); return; }
    if (choice === "bludgers") { await showBludgerControls(player); return; }
    if (choice === "bat") { await showBatChoice(player); return; }
    if (choice === "start") {
        const result = await Ui.input(player, {
            title: "Start Quidditch",
            fields: [{ name: "mode", label: "Mode", type: "select", default: MGR_MODE,
                options: Object.keys(CONFIG.modes).map((value) => ({ value, label: CONFIG.modes[value].label || value })) }],
            submitLabel: "Start",
        });
        if (result) { MGR_MODE = String(result.mode || MGR_MODE); startSession(MGR_MODE, player, true); }
        return;
    }
    const result = await Ui.input(player, {
        title: "Call Quidditch match",
        fields: [
            { name: "mode", label: "Mode", type: "select", default: MGR_MODE,
                options: Object.keys(CONFIG.modes).map((value) => ({ value, label: CONFIG.modes[value].label || value })) },
            { name: "teamA", label: "Home", type: "select", default: MGR_A,
                options: HOUSES.map((value) => ({ value, label: cap1(value) })) },
            { name: "teamB", label: "Away", type: "select", default: MGR_B,
                options: HOUSES.map((value) => ({ value, label: cap1(value) })) },
            { name: "ffa", label: "Open to all", type: "checkbox", default: MGR_FFA },
        ],
        submitLabel: "Call match",
    });
    if (!result) return;
    MGR_MODE = String(result.mode || MGR_MODE);
    MGR_A = String(result.teamA || MGR_A);
    MGR_B = String(result.teamB || MGR_B);
    MGR_FFA = !!result.ffa;
    openLobby(MGR_MODE, player, MGR_A, MGR_B, MGR_FFA);
}

// ---------------------------------------------------------------- rp-ui + commands

const pendingTeams = new Map();
// Same idea for the position. Roles are dealt round-robin without one, so a solo tester is a
// chaser by arithmetic and can never be the Seeker whose rule they are trying to check.
const pendingRoles = new Map();

const PASS_KEY = String((CONFIG.ball && CONFIG.ball.passKey) || "q").toLowerCase();
const SHOOT_KEY = String((CONFIG.ball && CONFIG.ball.shootKey) || "r").toLowerCase();
const SWING_KEY = String((CONFIG.bludgers && CONFIG.bludgers.swingKey) || "v").toLowerCase();
const BLOCK_KEY = String((CONFIG.keeper && CONFIG.keeper.blockKey) || "b").toLowerCase();
const TACKLE_KEY = String((CONFIG.keeper && CONFIG.keeper.tackleKey) || "t").toLowerCase();

if (Events.listenerCount("rp:ui:register") > 0) {
    Events.emit("rp:ui:register", {
        id: "quidditch",
        resource: "quidditch",
        actions: [
            // `prompt: true` is what makes rp-ui float a world plate over the ball reading "[E] Take
            // Quaffle" — it is opt-in, and without it the hotkey is bound but undiscoverable. The
            // plate needs an anchor too, which the context offer below supplies.
            { id: "quid.pickup", label: "Take Quaffle", hint: "Grab the loose ball", group: "Quidditch", order: 10, hotkey: "e", prompt: true },
            { id: "quid.pass", label: "Pass", hint: "Throw to the nearest team-mate", group: "Quidditch", order: 20, hotkey: PASS_KEY },
            { id: "quid.shoot", label: "Shoot", hint: "Throw at the hoops", group: "Quidditch", order: 30, tone: "gold", hotkey: SHOOT_KEY },
            { id: "quid.tackle", label: "Tackle", hint: "Put hands on the carrier", group: "Quidditch", order: 34, hotkey: TACKLE_KEY },
            { id: "quid.block", label: "Block", hint: "Clear the ball away", group: "Quidditch", order: 35, hotkey: BLOCK_KEY },
            { id: "quid.swing", label: "Swing", hint: "Bat the bludger away", group: "Quidditch", order: 40, hotkey: SWING_KEY },
            { id: "quid.join", label: "Join Match", hint: "Pick a position, or take an open seat", group: "Quidditch", order: 5 },
            { id: "quid.leave", label: "Leave Pitch", group: "Quidditch", order: 90 },
        ],
    });
}

// Every context build records why it did or did not offer the pickup, so `/quidditch why` can
// report the decision rp-ui actually re-validated against. A press that rp-ui rejects as "no longer
// legal" means this handler declined on THAT build — the manual `/rpui context` run is a different
// build, and it has been passing while the press fails, so the two have to be compared directly.
const CTX_LOG = [];

Events.on("rp:ui:context", (q) => {
    if (!q || !q.player) { CTX_LOG.unshift({ at: Date.now(), why: "no q.player" }); CTX_LOG.length = Math.min(CTX_LOG.length, 8); return; }
    if (!S) {
        // No session, but a lobby is still something to join. Without this the wheel went empty the
        // moment a match was called, which is exactly when someone is looking for a way in.
        if (LOBBY && lobbyEligible(q.player)) q.actions.push({ id: "quid.join" });
        CTX_LOG.unshift({ at: Date.now(), why: LOBBY ? "lobby open — offered join" : "no session" });
        CTX_LOG.length = Math.min(CTX_LOG.length, 8);
        return;
    }
    const seat = seatOf(q.player);
    if (!seat) {
        // The one person who needs an offer used to be the one person refused context entirely.
        q.actions.push({ id: "quid.join" });
        CTX_LOG.unshift({ at: Date.now(), why: `no seat for #${q.player.id} — offered join` });
        CTX_LOG.length = Math.min(CTX_LOG.length, 8);
        return;
    }
    const d = seat.lastPos ? Math.round(dist(seat.lastPos, S.ball.pos)) : -1;
    const near = S.ball.loose && seat.lastPos && d < (CONFIG.ball.pickupRadius || 700)
        && roleAllowed(seat, CONFIG.ball.carryRoles);
    CTX_LOG.unshift({ at: Date.now(), why: near ? "OFFERED" : `d=${d} loose=${S.ball.loose} pos=${!!seat.lastPos}`, id: q.player.id });
    CTX_LOG.length = Math.min(CTX_LOG.length, 8);
    if (near) {
        q.actions.push({ id: "quid.pickup", x: S.ball.pos.x, y: S.ball.pos.y, z: S.ball.pos.z });
    }
    if (S.ball.carrier === q.player.id) { q.actions.push({ id: "quid.pass" }); q.actions.push({ id: "quid.shoot" }); }
    // Beaters only, by `bludgers.swingRoles`. Role used to be a label here rather than a permission.
    if (nearestBludger(seat) && roleAllowed(seat, CONFIG.bludgers.swingRoles)) {
        q.actions.push({ id: "quid.swing" });
    }
    // Tackle: a Keeper, on a carrier, inside the scoring area. The offer shows a player exactly
    // when it is legal rather than making them guess -- but tackle() re-checks all of it, because
    // an offer is advisory and a client can name an action it was never shown.
    {
        const carrier = ballHolder();
        const k = CONFIG.keeper || {};
        if (roleAllowed(seat, k.tackleRoles)
            && carrier && carrier.player.id !== q.player.id && carrier.lastPos && seat.lastPos
            && dist(seat.lastPos, carrier.lastPos) <= (k.tackleRadius || 700)
            && inScoringArea(carrier.lastPos, endKeptBy(seat))) {
            q.actions.push({ id: "quid.tackle" });
        }
    }
    // The Keeper's, by `keeper.blockRoles`. This used to be offered to everyone, which meant a
    // Chaser in range saw Take Quaffle and Block at once -- two keys for one situation, and the
    // second one throws away the ball the first one would have won them.
    if (S.ball.loose && !S.ball.carrier && seat.lastPos
        && roleAllowed(seat, (CONFIG.keeper || {}).blockRoles)
        && dist(seat.lastPos, S.ball.pos) <= ((CONFIG.keeper && CONFIG.keeper.blockRadius) || 1000)) {
        q.actions.push({ id: "quid.block" });
    }
    q.actions.push({ id: "quid.leave" });
});

Events.on("rp:ui:action", (player, actionId) => {
    // Before the seat check, because having no seat is the precondition for this one.
    if (actionId === "quid.join") { joinSession(player); return; }
    const seat = seatOf(player);
    if (!seat || !S) return;
    if (actionId === "quid.pickup") {
        // Re-check the range here too. The wheel only OFFERS this in range, but the offer is
        // advisory — a client picks an action by id, and nothing stops it naming one it was never
        // shown. The pickup event path checks the same thing.
        if (!S.ball.loose || !seat.lastPos) return;
        if (dist(seat.lastPos, S.ball.pos) > (CONFIG.ball.pickupRadius || 700)) return;
        grantPossession(seat);
        return;
    }
    if (actionId === "quid.tackle") { tackle(seat); return; }
    if (actionId === "quid.block") {
        try { player.emit("quidditch:aimRequest", JSON.stringify({ kind: "block" })); } catch (_) {}
        return;
    }
    if (actionId === "quid.swing") {
        // Aim comes from the client and the launch is re-derived here — same contract as a throw.
        try { player.emit("quidditch:aimRequest", JSON.stringify({ kind: "swing" })); } catch (_) {}
        return;
    }
    if (actionId === "quid.leave") { S.players.delete(player.id); try { player.emit("quidditch:teardown", "{}"); } catch (_) {} return; }
    if (actionId === "quid.pass" || actionId === "quid.shoot") {
        try { player.emit("quidditch:aimRequest", JSON.stringify({ kind: actionId === "quid.pass" ? "pass" : "shoot" })); } catch (_) {}
    }
});

Events.on("chatCommand", async (player, message, command, args) => {
    if (command !== "quidditch") return;
    const sub = (args && args[0]) || "";
    if (MANAGE_SUBS.has(sub) && !(await requireManager(player))) return;
    // /quidditch call <house> <house> [mode]   — a fixture, told only to those two houses
    // /quidditch call ffa [mode]               — open to everyone, either side
    if (sub === "call") {
        const a = String(args[1] || "").toLowerCase();
        if (a === "ffa" || a === "open") {
            openLobby(args[2] || "match", player, null, null, true);
            return;
        }
        const b = String(args[2] || "").toLowerCase();
        if (a && !HOUSES.includes(a)) {
            player.sendChat(`Houses: ${HOUSES.join(", ")} — or "ffa". /quidditch call gryffindor slytherin`);
            return;
        }
        if (b && !HOUSES.includes(b)) {
            player.sendChat(`Houses: ${HOUSES.join(", ")}`);
            return;
        }
        openLobby(args[3] || "match", player, a || null, b || null, false);
        return;
    }
    if (sub === "cancel") {
        if (!LOBBY) { player.sendChat("No match has been called."); return; }
        if (player.id !== LOBBY.refereeId) { player.sendChat("Only the referee can call it off."); return; }
        closeLobby("The match was called off.");
        return;
    }
    if (sub === "lobby") {
        if (!LOBBY) { player.sendChat("No match has been called. /quidditch call [mode]"); return; }
        showLobby(player);
        return;
    }
    if (sub === "start") {
        // A called lobby wins: starting by hand should still seat the sides people picked, not
        // discard them and deal roles round-robin.
        if (LOBBY) { void startFromLobby(true).catch((error) => logger.warn(`Lobby start failed: ${error}`)); return; }
        const solo = String(args[2] || "").toLowerCase() === "solo" || String(args[2] || "").toLowerCase() === "force";
        startSession(args[1] || "snitchHunt", player, solo);
        return;
    }
    if (sub === "stop") { endSession("stopped"); return; }
    if (sub === "team") {
        const house = String(args[1] || "").toLowerCase();
        if (!HOUSES.includes(house)) { player.sendChat(`Houses: ${HOUSES.join(", ")}`); return; }
        pendingTeams.set(player.id, house);
        player.sendChat(`You will play for ${house}.`);
        return;
    }
    if (sub === "join") { joinSession(player); return; }
    if (sub === "pitch") { goToPitch(player); return; }
    if (sub === "role") {
        const role = String(args[1] || "").toLowerCase();
        if (!CONFIG.roles.includes(role)) { player.sendChat(`Roles: ${CONFIG.roles.join(", ")}`); return; }
        pendingRoles.set(player.id, role);
        const seat = seatOf(player);
        if (!seat) { player.sendChat(`You will play as ${role}.`); return; }
        // Live, so a rule can be checked without restarting the session to check it.
        seat.role = role;
        pushBat(player, roleAllowed(seat, CONFIG.bludgers.swingRoles) ? CONFIG.bludgers.bat : "");
        pushHud(seat);
        if (Events.listenerCount("rp:ui:context:poke") > 0) {
            try { Events.emit("rp:ui:context:poke", player); } catch (_) {}
        }
        player.sendChat(`You are now ${role}.`);
        return;
    }
    if (sub === "open" || sub === "manager") {
        void showManager(player).catch((error) => logger.warn(`Manager failed for ${player.id}: ${error}`));
        return;
    }
    // Probe surface: drop a lone quaffle in front of you with no session running, so Accio /
    // Wingardium / Depulso can be tested against a SmallPhysicsProp body on its own.
    if (sub === "ball") {
        let p = null;
        try { p = player.position; } catch (_) {}
        if (!p) { player.sendChat("No position yet."); return; }
        const ball = spawnQuaffle(TEST_QUAFFLE_KEY, { x: p.x, y: p.y, z: p.z + 250 });
        if (ball) ball.setVirtualWorld(player.virtualWorld);
        player.sendChat(ball ? "Quaffle dropped in front of you. /quidditch ballclear to remove it." : "Quaffle spawn failed — check ball.mesh.");
        return;
    }
    if (sub === "ballclear") {
        player.sendChat(WorldObject.destroy(TEST_QUAFFLE_KEY) ? "Quaffle removed." : "No test quaffle to remove.");
        return;
    }
    // Ground truth for "why can I not pick this up". Answers the three things that decide it: where
    // the server thinks the ball is, how far that is from you against the pickup radius, and whether
    // it is resting on the deck or still falling.
    // Press E, get the rejection, then run this. The top line is the build rp-ui re-validated
    // against, so it says exactly which term of the predicate was false at that instant.
    // Preview the results panel. With a session it shows the real one; without, a sample — so the
    // layout can be checked without playing a match to the end.
    if (sub === "results") {
        // A preview outside a session has no teardown to clean it up, so it needs its own way out.
        if (String(args[1] || "").toLowerCase() === "off") {
            try { player.emit("quidditch:resultsClose", "{}"); } catch (_) {}
            player.sendChat("Results panel closed.");
            return;
        }
        const d = S ? resultsPayload("snitch") : {
            reason: "snitch", mode: "Full Match", winner: "gryffindor", durationSec: 247,
            score: [{ house: "gryffindor", points: 190 }, { house: "slytherin", points: 60 }],
            players: [
                { name: player.nickname || "You", team: "gryffindor", role: "seeker", goals: 1, snitch: 1, points: 160 },
                { name: "Weasley", team: "gryffindor", role: "chaser", goals: 3, snitch: 0, points: 30 },
                { name: "Malfoy", team: "slytherin", role: "chaser", goals: 6, snitch: 0, points: 60 },
                { name: "Crabbe", team: "slytherin", role: "beater", goals: 0, snitch: 0, points: 0 },
            ],
        };
        d.afterMs = 200;   // no banner to wait behind when previewing
        try { player.emit("quidditch:results", JSON.stringify(d)); } catch (_) {}
        player.sendChat(S ? "Results panel (live session)." : "Results panel (sample data).");
        return;
    }
    // Preview the banners without having to score, which matters because scoring is the one path
    // still unproven — and a demo recording should not be the first time these are seen.
    // Bisect: is the mesh not rendering, or is it just not where anyone looks? This drops one in
    // front of you at a size you cannot miss.
    if (sub === "bannertest") {
        let p = null;
        try { p = player.position; } catch (_) {}
        if (!p) { player.sendChat("No position yet."); return; }
        const house = String(args[1] || "gryffindor").toLowerCase();
        const mesh = (P.goalBanners || {})[house];
        if (!mesh) { player.sendChat(`Houses: ${Object.keys(P.goalBanners || {}).join(", ")}`); return; }
        const scale = Number(args[2]) || 3;
        // Four of them, one per quarter turn. A banner is a flat plane and its material may well be
        // single-sided, in which case three of these are invisible and the fourth is the answer —
        // which is a thing to see rather than reason about.
        const yaw = args[3] !== undefined ? Number(args[3]) : null;
        const spread = yaw === null ? [0, 90, 180, 270] : [yaw];
        const banners = spread.map((y, i) => ({
            mesh, x: p.x + 600 + i * 500, y: p.y, z: p.z, yaw: y, scale,
        }));
        placeBanners(banners);
        player.sendChat(yaw === null
            ? `Four ${house} banners in front of you at yaw 0 / 90 / 180 / 270 — which face you?`
            : `Banner ${house} at yaw ${yaw}, scale ${scale}.`);
        return;
    }
    if (sub === "banner") {
        const which = String(args[1] || "goal").toLowerCase();
        const house = String(args[2] || "gryffindor").toLowerCase();
        const payload = which === "snitch"
            ? { size: "snitch", house, text: "The Snitch is caught", subLead: house, subTail: `· +${CONFIG.snitch.points}`, holdMs: 4200 }
            : { size: "goal", house, lead: house, tail: "score", sub: `+${CONFIG.scoring.goal}` };
        try { player.emit("quidditch:banner", JSON.stringify(payload)); } catch (_) {}
        player.sendChat(`Banner: ${which} (${house}). /quidditch banner snitch slytherin`);
        return;
    }
    // Escape hatch. A stuck rider cannot type their way out of a broom flag stack any other way.
    if (sub === "unstick") {
        try { player.emit("quidditch:unstick", "{}"); } catch (_) {}
        clearStunCard(player.id);
        if (S) S.stunned.delete(player.id);
        player.sendChat("Input restored.");
        return;
    }
    if (sub === "bat") {
        const arg = String(args[1] || "").toLowerCase();
        if (arg === "off") { pushBat(player, ""); player.sendChat("Bat put away."); return; }
        const list = (CONFIG.bludgers.bats || []).map((b) => b.id);
        const match = list.find((id) => id.toLowerCase() === arg);
        if (!arg) { player.sendChat(`/quidditch bat <${list.join("|")}|off>  — current ${CONFIG.bludgers.bat}`); return; }
        if (!match) { player.sendChat(`Unknown bat. Try: ${list.join(", ")}`); return; }
        CONFIG.bludgers.bat = arg;
        pushBat(player, arg);
        player.sendChat(`Bat: ${arg}.`);
        return;
    }
    if (sub === "bludgers") {
        const n = Number(args[1]);
        if (isNaN(n)) { player.sendChat(`/quidditch bludgers <n>  — currently ${bludgerCount ?? CONFIG.bludgers.count}`); return; }
        bludgerCount = Math.max(0, Math.min(MAX_BLUDGERS, Math.round(n)));
        player.sendChat(`Bludgers set to ${bludgerCount}. Takes effect on the next start.`);
        return;
    }
    if (sub === "why") {
        if (!CTX_LOG.length) { player.sendChat("No context builds recorded — is rp-ui running?"); return; }
        const now = Date.now();
        for (const e of CTX_LOG) player.sendChat(`${String(now - e.at).padStart(5)} ms ago — ${e.why}${e.id !== undefined ? ` (#${e.id})` : ""}`);
        return;
    }
    if (sub === "ballwhere") {
        if (!S) { player.sendChat("No session — /quidditch start practice solo"); return; }
        const b = S.ball.pos;
        const seat = seatOf(player);
        const d = seat && seat.lastPos ? Math.round(dist(seat.lastPos, b)) : -1;
        const aboveDeck = Math.round(b.z - DECK_Z);
        const moved = S.ball.prev ? Math.round(dist(S.ball.prev, b)) : -1;
        player.sendChat(`Ball (${Math.round(b.x)}, ${Math.round(b.y)}, ${Math.round(b.z)}) — ${aboveDeck} cm above deck`);
        player.sendChat(`You are ${d} cm away (pickup at ${CONFIG.ball.pickupRadius}), moved ${moved} cm last tick`);
        player.sendChat(`loose=${S.ball.loose} carrier=${S.ball.carrier || "none"} simulator=${S.ball.obj ? S.ball.obj.ownerId : "none"} you=${player.id}`);
        return;
    }
    // Hoop placement is the one thing that genuinely needs eyes in-game, so it is tunable live.
    // Trail scale is baked in at spawn, so testing a value means respawning the snitch. Fast loop,
    // because "is this VFX rendering at all" needs several attempts to answer honestly.
    if (sub === "trail") {
        const scale = Number(args[1]);
        if (isNaN(scale)) { player.sendChat(`/quidditch trail <scale>  — current ${CONFIG.snitch.trailScale}`); return; }
        CONFIG.snitch.trailScale = scale;
        if (!S || !S.snitch.obj) { player.sendChat("No released snitch — start a session first."); return; }
        spawnSnitch();
        broadcast("quidditch:resnitch", { id: S.snitch.obj ? S.snitch.obj.id : 0 });
        player.sendChat(`Snitch respawned with trail scale ${scale}.`);
        return;
    }
    if (sub === "hoopheight") {
        const outer = Number(args[1]), mid = Number(args[2]);
        if (isNaN(outer)) { player.sendChat("/quidditch hoopheight <outer> [centre]  — cm above the deck"); return; }
        HOOPS = buildHoops({ heights: [outer, isNaN(mid) ? outer : mid, outer] });
        pushHoops(true);
        const g = tuning();
        player.sendChat(`Hoops: dist ${g.goalDistance}, spacing ${g.spacing}, heights ${g.heights.join("/")} above deck.`);
        return;
    }
    if (sub === "hoops") {
        const over = {};
        if (args[1] !== undefined && !isNaN(Number(args[1]))) over.goalDistance = Number(args[1]);
        if (args[2] !== undefined && !isNaN(Number(args[2]))) over.axisDeg = Number(args[2]);
        if (args[3] !== undefined && !isNaN(Number(args[3]))) over.spacing = Number(args[3]);
        if (args[4] !== undefined && !isNaN(Number(args[4]))) over.yawOffset = Number(args[4]);
        HOOPS = buildHoops(over);
        pushHoops(true);
        const g = tuning();
        player.sendChat(`Hoops: dist ${g.goalDistance}, axis ${g.axisDeg}, spacing ${g.spacing}, yaw+${g.yawOffset || 0}, heights ${g.heights.join("/")}.`);
        return;
    }
    // The mounted-cast unlock is applied on session setup, so outside a session casting on a broom
    // is still stock (Revelio only). This toggles it on its own for probing.
    if (sub === "cast") {
        const on = String(args[1] || "on").toLowerCase() !== "off";
        try { player.emit("quidditch:testCast", JSON.stringify({ on })); } catch (_) {}
        player.sendChat(`Mounted casting ${on ? "unlocked" : "restored to stock"} on your client.`);
        return;
    }
    if (S) { player.sendChat(`Quidditch: ${CONFIG.modes[S.mode].label}, ${seats().length} on the pitch.`); return; }
    player.sendChat("Quidditch: idle.  /quidditch start <mode> [solo]  |  /quidditch ball  |  /quidditch cast on");
});

const unregisterPitch = Interact.register({
    id: "quidditch.pitch",
    resource: RESOURCE,
    label: "Quidditch",
    description: "Join the lineup or manage a match.",
    position: { x: CENTRE.x, y: CENTRE.y, z: DECK_Z + (P.spawnHeight || 0) },
    radius: 450,
    promptDistance: 350,
    requirements: { character: true },
    handler({ player }) {
        if (LOBBY && lobbyEligible(player)) void showLobby(player);
        else void showManager(player).catch((error) => logger.warn(`Manager failed for ${player.id}: ${error}`));
    },
});

function status() {
    return {
        state: S ? (S.ending ? "ending" : "running") : (LOBBY ? "forming" : "idle"),
        mode: S ? S.mode : (LOBBY ? LOBBY.mode : null),
        players: S ? S.players.size : (LOBBY ? LOBBY.picks.size : 0),
        activitySessionId: S ? S.activitySessionId : (LOBBY ? LOBBY.activitySessionId : null),
        dependencies: {
            activities: Activities.status().state,
            houses: Houses.status().state,
            world: FoundationWorld.status().state,
        },
    };
}

Exports.register("status", status);
Exports.register("call", (referee, mode = "match", teamA, teamB, ffa = false) => openLobby(mode, referee, teamA, teamB, ffa));
Exports.register("start", (starter, mode = "match", solo = false) => startSession(mode, starter, solo));
Exports.register("stop", (reason = "external") => endSession(reason));

Events.on("playerConnect", (player) => {
    void Houses.membership.sync(player).catch((error) => logger.warn(`House sync failed for ${player.id}: ${error}`));
});

// Eligibility is the character's house, and a connecting client is not yet listening, so a call in
// progress reaches a late joiner once their character has loaded.
Events.on("hmp:character:loaded", (payload) => {
    const player = payload && payload.session && payload.session.player;
    if (player && LOBBY) pushLobbyCard(player);
});

// The card's key: the picker opens only when somebody asks for it.
Events.onClient("quidditch:lobbyOpen", (player) => {
    if (LOBBY && lobbyEligible(player)) void showLobby(player);
});

Events.on("playerDisconnect", (player) => {
    if (LOBBY) {
        LOBBY.picks.delete(player.id);
        // The referee leaving would otherwise strand a lobby nobody can start or cancel.
        if (player.id === LOBBY.refereeId) closeLobby("The referee left — the match was called off.");
        else pushLobbyCards();
    }
    if (!S) return;
    if (S.ball.carrier === player.id) dropBall("disconnect");
    // Hold the seat before letting go of it, so a crash costs a minute rather than the match.
    const seat = S.players.get(player.id);
    if (seat && seat.team) {
        S.vacated.set(nameKey(player), {
            team: seat.team, role: seat.role, stats: seat.stats,
            until: Date.now() + ((CONFIG.lobby && CONFIG.lobby.rejoinSeconds) || 300) * 1000,
        });
    }
    S.players.delete(player.id);
    if (!S.players.size) endSession("empty");
});

// World objects belong to the server, not the script, so a hot reload would otherwise strand them.
Events.on("resourceStop", (name) => {
    if (name && name !== RESOURCE) return;
    if (LOBBY) closeLobby("Quidditch resource stopped.");
    if (S) endSession("resource stopped");
    placeBanners([]);
    clearBludgers();
    clearQuaffle();
    clearHoopObjects();
    clearSnitch();
    try { WorldObject.destroy(TEST_QUAFFLE_KEY); } catch (_) {}
    unregisterPitch();
    void unregisterActivity();
    FoundationAudio.sounds.release(AUDIO_OWNER);
    clearMatchBlips();
});

logger.info("Server ready");
