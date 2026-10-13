/**
 * quidditch resource — client script (the renderer).
 *
 * The server decides everything; this file draws it. The pitch itself (ball, hoops, snitch,
 * bludgers) is server WorldObjects and the markers are hmp-blips, so what is left here is the
 * overlays, the keybinds, the bat and the knock reaction. It reports aim and is never asked for a
 * verdict.
 *
 * Two engine facts drive the odd-looking bits below:
 *  - A relayed Able ability can carry m_Length = +inf and park on its channel forever, because the
 *    Behaviour Tree that normally ends it is not involved. Every playAbility here has a paired
 *    cancelAbilityHandle on a timer.
 *  - Casting while broom-mounted is off in the stock game (only Revelio). Broom.setCastingAllowed
 *    flips the GameLogic BoolVar that frees it — per client, per session, no save write.
 */

const RESOURCE = "hmp-quidditch";
const Hmp = Imports.get("hmp-lib");
const FoundationWorld = Imports.get("hmp-world");
const logger = Hmp.logger.create(RESOURCE);

logger.info("Client loading");

let session = null;
let carrying = false;    // whether this client holds the quaffle, read off its WorldObject
let ballNetId = 0;       // the server quaffle's WorldObject id
// Per CHANNEL, not one shared handle. Every ability here carries m_Length = +inf and needs a paired
// cancel; with a single timer, a throw followed by a bludger hit clears the first timer and only the
// second channel is ever released. Today they all happen to use PartialBody, so it is survivable —
// but it survives by luck, and the config lets a channel be changed.
const cancelTimers = new Map();
let batOn = false;       // whether a held prop (the beater bat) is currently equipped

const on = (event, handler) => Events.on(event, (raw) => {
    let data = {};
    try { data = typeof raw === "string" ? JSON.parse(raw || "{}") : (raw || {}); } catch (_) {}
    try { handler(data); } catch (err) { console.error(`[QUIDDITCH] ${event}: ${err}`); }
});

function teardown() {
    closeBanner();
    closeScoreboard();
    closeResults();
    ballNetId = 0;
    dropBat();
    if (mountNag) { clearInterval(mountNag); mountNag = null; }
    if (stunTimer) { clearTimeout(stunTimer); stunTimer = null; }
    if (stunHeld) { try { Broom.setInputDisabled(false); } catch (_) {} stunHeld = false; }
    try { LocalPlayer.clearProp(); } catch (_) {}
    if (session) {
        if (session.unlockCasting) { try { Broom.setCastingAllowed(false); } catch (_) {} }
        if (session.liftLimits) {
            try { Broom.clearMaxHeight(); } catch (_) {}
        }
    }
    session = null;
    carrying = false;
    try { FoundationWorld.policy.restore(); } catch (_) {}
}

let mountNag = null;

/**
 * Ask people to get on their brooms. There is no way to do it FOR them: the local mount runs
 * through ABroomItemTool into AFlyingBroom.PlayerMountAbility, and nothing the mod exposes
 * reaches either. So the pitch puts everyone on the deck and this says the rest.
 *
 * It ASKS before it speaks -- Broom.mounted() is cheap and already exposed -- so somebody who
 * arrived flying is never told to do what they have done. Three tries, then it gives up: a
 * message that will not stop is worse than no message.
 */
function nudgeToMount() {
    if (mountNag) { clearInterval(mountNag); mountNag = null; }
    let left = 3;
    const ask = () => {
        if (!session) { clearInterval(mountNag); mountNag = null; return; }
        let up = false;
        try { up = !!Broom.mounted(); } catch (_) { up = true; }   // unreadable: assume flying, say nothing
        if (up || left-- <= 0) { clearInterval(mountNag); mountNag = null; return; }
        Game.notify("Mount your broom to play.");
    };
    ask();
    mountNag = setInterval(ask, 5000);
}

on("quidditch:setup", (data) => {
    teardown();
    session = data;

    // Both are per-client session state, not persisted: the pitch carries NoMount volumes and a
    // region flight ceiling, and neither survives teardown below.
    if (data.liftLimits) {
        try { FoundationWorld.policy.restore(); } catch (_) {}
        if (typeof data.ceiling === "number") { try { Broom.setMaxHeight(data.ceiling); } catch (_) {} }
    }
    if (data.unlockCasting) { try { Broom.setCastingAllowed(true); } catch (_) {} }
    openBanner();   // warm the overlay now, so the first goal is not the thing that builds it
    openScoreboard();   // the server's first push follows seating

    // The hoops, the quaffle, the bludgers and the snitch are server WorldObjects, streamed in like
    // any other; this side only watches the quaffle to know when it is in this player's hand.
    ballNetId = data.ballId || 0;
    if (data.bat) equipBat(data.bat, data.batSocket, data.batOffset);
    Game.notify(`Quidditch: ${data.mode} — you are ${data.role} for ${data.team}.`);
    nudgeToMount();
});

on("quidditch:unstick", () => {
    if (stunTimer) { clearTimeout(stunTimer); stunTimer = null; }
    stunHeld = false;
    // Pop a few times: the stack takes one entry per push, and a stuck player may have several.
    for (let i = 0; i < 5; i++) { try { Broom.setInputDisabled(false); } catch (_) {} }
    // PartialBody ONLY. FullBody carries the broom's own pose ability (ABL_HoverBroom_Idle_*), so
    // cancelling it strips the rider to an A-pose — which is what the first version of this did.
    try { LocalPlayer.cancelAbility("PartialBody"); } catch (_) {}
    try { Broom.setForceLand(false); } catch (_) {}
    Game.notify("Input restored.");
});

on("quidditch:teardown", () => { teardown(); Game.notify("Quidditch: session over."); });

// Chat is behind the focused panel, so refusals have to surface where the click happened.
on("quidditch:notice", (data) => { if (data.text) Game.notify(data.text); });

// The gate is a GameLogic BoolVar, so it applies to the whole client, not to a broom instance — it
// can be set on the ground and is still in force once mounted.
on("quidditch:testCast", (data) => {
    let ok = false;
    try { ok = !!Broom.setCastingAllowed(!!data.on); } catch (_) {}
    Game.notify(ok
        ? `Mounted casting ${data.on ? "unlocked" : "restored"}.`
        : "Mounted-cast toggle failed — no GameLogicComponent on the pawn.");
});

// The same event serves the release and a respawn (trail tuning, a reset); only one of them is news.
on("quidditch:resnitch", (data) => {
    if (session && data.released) Game.notify("The Snitch is released!");
});

// You cannot tell a proximity hold is running by looking at it, so say so.
on("quidditch:catching", (data) => {
    if (data.on) Game.notify(`Closing on the Snitch — hold it for ${((data.ms || 1200) / 1000).toFixed(1)}s`);
});

on("quidditch:snitchBlip", (data) => {
    Game.notify(`Snitch minimap blip ${data.on ? "on" : "off"}.`);
});

// The quaffle itself is a server physics object: carrying, throwing and resetting all happen on the
// entity, so this side only plays the throw.
on("quidditch:ballThrow", () => playThrowAnimation());

on("quidditch:goal", () => { try { Camera.playShake("", { scale: 0.4 }); } catch (_) {} });

/**
 * A bludger hit is a partial-body reaction plus a control lock — no damage call, and deliberately
 * not DismountBroom, which writes 'ActiveMountItem' into the save.
 */
on("quidditch:knock", (data) => {
    const cfg = (session && session.bludgers) || {};
    const ability = cfg.reactionAbility || "/Game/Pawn/Student/Abilities/PartialBody/Broom/ABL_HoverBroom_Hitch_Frnt.ABL_HoverBroom_Hitch_Frnt_C";
    const channel = cfg.reactionChannel || "PartialBody";
    playFor(ability, channel, cfg.reactionCancelMs || 1200);
    // Input lock OFF by default. setInputDisabled is a push/pop on the broom flag stack, and a pop
    // that does not land leaves a rider permanently unable to steer — which happened, twice, and
    // neither the retry nor the unstick freed it. A bludger that staggers you visually and costs you
    // the quaffle is worth more than one that risks ending your session.
    if ((session && session.bludgers && session.bludgers.stunDisablesInput)) {
        stunInput(data.ms || 1800);
    }
    try { Camera.playShake("", { scale: 0.8 }); } catch (_) {}
});

function playThrowAnimation() {
    const ability = "/Game/Pawn/Student/Abilities/PartialBody/UseInventoryItem/Potion/ABL_Partial_ThrowInventoryItem.ABL_Partial_ThrowInventoryItem_C";
    playFor(ability, "PartialBody", 1200);
}

/**
 * Play an ability and guarantee its channel is released.
 *
 * Every ability this resource plays carries m_Length = +inf, so without a paired cancel it parks on
 * its channel forever — in shipped play a Behaviour Tree tears them down, and a relayed play has no
 * BT. Keyed by channel so two abilities in flight cannot cancel each other's release.
 */
/**
 * Take rider input for a moment, and be certain it comes back.
 *
 * setInputDisabled is a PUSH/POP pair on the broom's flag stack — Start pushes at Debug priority,
 * Finish pops — and BOTH ends need MountedBroom() to resolve. Firing the release once and trusting
 * it is how a player ends up permanently unable to steer: if the broom is momentarily unresolvable
 * when the timer lands, the push simply stays on the stack and nothing ever pops it.
 *
 * So: at most one push outstanding, and a release that retries until it is actually taken.
 */
let stunHeld = false;
let stunUntil = 0;
let stunTimer = null;

function stunInput(ms) {
    const now = Date.now();
    stunUntil = Math.max(stunUntil, now + ms);
    if (!stunHeld) {
        try { stunHeld = !!Broom.setInputDisabled(true); } catch (_) { stunHeld = false; }
    }
    if (stunTimer) clearTimeout(stunTimer);
    stunTimer = setTimeout(() => releaseStun(0), Math.max(0, stunUntil - now));
}

/**
 * Self-heal. The override stack is weak-instigator-keyed and NOT refcounted, so our (Debug, null)
 * entry is a single entry and one Finish clears it — the only way to stay locked is for that Finish
 * never to be CALLED. This runs while a session is up and pops whenever we believe we should not be
 * stunned, which turns 'permanently unable to steer' into 'at most a couple of seconds'.
 *
 * Popping when nothing is pushed is free: Finish returns false and changes nothing.
 */
setInterval(() => {
    if (!session || stunHeld) return;
    try { Broom.setInputDisabled(false); } catch (_) {}
}, 2000);

function releaseStun(tries) {
    stunTimer = null;
    if (!stunHeld) return;
    let ok = false;
    try { ok = !!Broom.setInputDisabled(false); } catch (_) {}
    if (ok) { stunHeld = false; return; }
    // Not mounted yet, or the broom did not resolve. Keep trying — giving up here strands the player.
    if (tries < 40) { stunTimer = setTimeout(() => releaseStun(tries + 1), 250); return; }
    stunHeld = false;
    console.error("[QUIDDITCH] could not restore broom input after 10s — the flag stack may still hold it");
}

function playFor(ability, channel, ms) {
    let handle = null;
    try { handle = LocalPlayer.playAbility(ability, channel); } catch (_) {}
    if (!handle) return;
    const prev = cancelTimers.get(channel);
    if (prev) clearTimeout(prev);
    // By handle: ends OUR ability only. A channel-wide cancel here used to hit whatever had replaced it.
    cancelTimers.set(channel, setTimeout(() => {
        cancelTimers.delete(channel);
        try { LocalPlayer.cancelAbilityHandle(handle); } catch (_) {}
    }, ms));
}

function aimForward() {
    const rot = LocalPlayer.getControlRotation();
    if (!rot) return null;
    const pitch = (rot.pitch || 0) * Math.PI / 180;
    const yaw = (rot.yaw || 0) * Math.PI / 180;
    return { x: Math.cos(pitch) * Math.cos(yaw), y: Math.cos(pitch) * Math.sin(yaw), z: Math.sin(pitch) };
}

function throwBall(speed) {
    const dir = aimForward();
    if (!dir) return;
    Events.emitServer("quidditch:throw", JSON.stringify({ x: dir.x, y: dir.y, z: dir.z, speed }));
}

on("quidditch:aimRequest", (data) => {
    const dir = aimForward();
    if (!dir) return;
    // A swing carries no speed: the server owns how hard a bludger leaves, we only say where.
    if (data.kind === "block") {
        Events.emitServer("quidditch:block", JSON.stringify({ x: dir.x, y: dir.y, z: dir.z }));
        return;
    }
    if (data.kind === "swing") {
        Events.emitServer("quidditch:swing", JSON.stringify({ x: dir.x, y: dir.y, z: dir.z }));
        return;
    }
    const cfg = (session && session.ball) || {};
    throwBall(data.kind === "shoot" ? (cfg.throwSpeedMax || 4500) : (cfg.throwSpeed || 3000));
});

// Confirmation of a connected swing. Paired cancel, like every playAbility here: a relayed
// ability with m_Length = +inf parks on its channel forever without a Behaviour Tree to end it.
on("quidditch:swung", () => {
    const cfg = (session && session.bludgers) || {};
    const ability = cfg.swingAbility
        || "/Game/Pawn/Student/Abilities/PartialBody/Conjuring/ABL_ConjuringObject_SwipeRight.ABL_ConjuringObject_SwipeRight_C";
    const channel = cfg.swingChannel || "PartialBody";
    playFor(ability, channel, cfg.swingCancelMs || 900);
    try { Camera.playShake("", { scale: 0.3 }); } catch (_) {}
});

// Foundations arbitrates all physical keys. Server handlers repeat every range, role and possession
// check, so these callbacks express intent only.
const registerShortcut = (id, key, handler, when = () => !!session) => Hmp.input.shortcuts.register({
    resource: RESOURCE, id, key, state: "down", priority: 40, when, handler,
});
registerShortcut("pickup", "e", () => Events.emitServer("quidditch:pickup", "{}"));
registerShortcut("pass", "q", () => throwBall((((session || {}).ball || {}).throwSpeed) || 3000), () => !!session && carrying);
registerShortcut("shoot", "r", () => throwBall((((session || {}).ball || {}).throwSpeedMax) || 4500), () => !!session && carrying);
registerShortcut("swing", "v", () => {
    const dir = aimForward();
    if (dir) Events.emitServer("quidditch:swing", JSON.stringify(dir));
});
registerShortcut("block", "b", () => {
    const dir = aimForward();
    if (dir) Events.emitServer("quidditch:block", JSON.stringify(dir));
});
registerShortcut("tackle", "t", () => Events.emitServer("quidditch:tackle", "{}"));

// Pass and shoot are only offered while the quaffle rides this player's hand: an attached object's
// owner is its carrier, so owner-and-attached on this client means the ball is ours.
setInterval(() => {
    let state = null;
    if (session && ballNetId) { try { state = World.worldObjectState(ballNetId); } catch (_) {} }
    carrying = !!(state && state.owner && state.attached);
}, 100);

// ------------------------------------------------------------------ the beater bat, held

/**
 * The held prop — the beater bat. Cosmetic, so every step is best-effort: a bat that fails to
 * appear must never stop a session starting.
 *
 * equipProp handles static and skeletal assets alike (three of the shipped bats are static shop or
 * station meshes, one is the rigged Beater prop), so this only has to pass a path. The offset is
 * live because WandSocket is authored for a short wand and a long bat will not sit right in it.
 */
function equipBat(mesh, socket, offset) {
    if (!mesh) { dropBat(); return; }
    let ok = false;
    try { ok = !!LocalPlayer.equipProp(mesh, socket || "WandSocket"); } catch (_) {}
    if (!ok) { Game.notify("Bat failed to equip — check the log: the asset may not be a mesh."); return; }
    Game.notify("Bat equipped.");
    applyBatOffset(offset);
    batOn = true;
}

function applyBatOffset(o) {
    const d = o || {};
    try {
        LocalPlayer.setPropOffset(d.pitch || 0, d.yaw || 0, d.roll || 0,
                                d.x || 0, d.y || 0, d.z || 0, d.scale || 1);
    } catch (_) {}
}

function dropBat() {
    if (!batOn) return;
    try { LocalPlayer.clearProp(); } catch (_) {}
    batOn = false;
}

on("quidditch:bat", (data) => {
    if (!data.mesh) { dropBat(); Game.notify("Bat put away."); return; }
    equipBat(data.mesh, data.socket, data.offset);
});

// ---------------------------------------------------------------- banner overlay

/**
 * Goals and the snitch catch, across the screen. Deliberately NOT focused and never locking: a
 * focused CEF view holds the cursor and takes controls, which mid-flight would fly you into the
 * stands. showView alone leaves every input with the game, which is the whole requirement here.
 */
const BANNER_URL = "fw://resources/hmp-quidditch/dist/banner.html";
let bannerView = -1;
let bannerReady = false;
let bannerQueue = [];

function openBanner() {
    if (bannerView >= 0) return;
    try { bannerView = Web.createView(BANNER_URL); } catch (_) { bannerView = -1; }
    if (bannerView < 0) return;   // web layer not up yet; the next banner retries
    // The page can miss an event fired before its script ran — on a cold boot the HTML is still
    // syncing down — so it announces itself and we flush what was queued meanwhile.
    Web.on(bannerView, "quid:bannerReady", () => {
        bannerReady = true;
        for (const b of bannerQueue.splice(0)) { try { Web.emit(bannerView, "quid:banner", b); } catch (_) {} }
    });
    try { Web.showView(bannerView); } catch (_) {}
}

// A plain destroy is safe: the SERVER holds the session open for `scoring.celebrateMs` after the
// thing worth announcing, so teardown no longer races the banner it just fired.
function closeBanner() {
    bannerReady = false;
    bannerQueue = [];
    if (bannerView < 0) return;
    try { Web.hideView(bannerView); Web.destroyView(bannerView); } catch (_) {}
    bannerView = -1;
}

on("quidditch:banner", (data) => {
    openBanner();
    if (bannerView < 0 || !bannerReady) {
        bannerQueue.push(data);
        if (bannerQueue.length > 4) bannerQueue.shift();
        return;
    }
    try { Web.emit(bannerView, "quid:banner", data); } catch (_) {}
});

// ---------------------------------------------------------------- scoreboard overlay

// Same contract as the banner: shown, never focused. It is up for the whole session rather than
// for a moment, which makes the focus rule matter more here, not less.
const SCORE_URL = "fw://resources/hmp-quidditch/dist/scoreboard.html";
let scoreView = -1;
let scoreReady = false;
let scoreLast = null;   // replayed on ready: the view can outlive its first push on a cold boot

function openScoreboard() {
    if (scoreView >= 0) return;
    try { scoreView = Web.createView(SCORE_URL); } catch (_) { scoreView = -1; }
    if (scoreView < 0) return;
    Web.on(scoreView, "quid:scoreReady", () => {
        scoreReady = true;
        if (scoreLast) { try { Web.emit(scoreView, "quid:score", scoreLast); } catch (_) {} }
    });
    try { Web.showView(scoreView); } catch (_) {}
}

function closeScoreboard() {
    scoreReady = false;
    scoreLast = null;
    if (scoreView < 0) return;
    try { Web.hideView(scoreView); Web.destroyView(scoreView); } catch (_) {}
    scoreView = -1;
}

on("quidditch:scoreboard", (data) => {
    openScoreboard();
    scoreLast = data;
    if (scoreView < 0 || !scoreReady) return;   // the ready handshake replays it
    try { Web.emit(scoreView, "quid:score", data); } catch (_) {}
});

// ---------------------------------------------------------------- results panel

// Same rules as the banner: shown, never focused. It reads out and fades — nothing to click, so
// nothing that could strand the player behind a locked cursor.
const RESULTS_URL = "fw://resources/hmp-quidditch/dist/results.html";
let resultsView = -1;
let resultsReady = false;
let resultsPending = null;

function closeResults() {
    resultsReady = false;
    resultsPending = null;
    if (resultsView < 0) return;
    try { Web.hideView(resultsView); Web.destroyView(resultsView); } catch (_) {}
    resultsView = -1;
}

on("quidditch:resultsClose", () => closeResults());

on("quidditch:results", (data) => {
    if (resultsView < 0) {
        try { resultsView = Web.createView(RESULTS_URL); } catch (_) { resultsView = -1; }
        if (resultsView < 0) return;
        Web.on(resultsView, "quid:resultsReady", () => {
            resultsReady = true;
            if (resultsPending) { try { Web.emit(resultsView, "quid:results", resultsPending); } catch (_) {} }
            resultsPending = null;
        });
        try { Web.showView(resultsView); } catch (_) {}
    }
    if (!resultsReady) { resultsPending = data; return; }
    try { Web.emit(resultsView, "quid:results", data); } catch (_) {}
});

// ---------------------------------------------------------------- match call card

// A called match, as a small card on the right. Shown, never focused: everyone eligible gets one,
// and somebody who does not want to play must be able to carry on as if it were not there. The key
// is only bound while a call is up, and only it opens the (focused) picker.
const LOBBY_URL = "fw://resources/hmp-quidditch/dist/lobby.html";
let lobbyView = -1;
let lobbyReady = false;
let lobbyLast = null;
let lobbyKey = null;   // unregister for the join shortcut, bound while a card is up

function closeLobbyCard() {
    lobbyReady = false;
    lobbyLast = null;
    if (lobbyKey) { try { lobbyKey(); } catch (_) {} lobbyKey = null; }
    if (lobbyView < 0) return;
    try { Web.hideView(lobbyView); Web.destroyView(lobbyView); } catch (_) {}
    lobbyView = -1;
}

on("quidditch:lobbyCard", (data) => {
    if (data.closed) { closeLobbyCard(); return; }
    lobbyLast = data;
    if (lobbyView < 0) {
        try { lobbyView = Web.createView(LOBBY_URL); } catch (_) { lobbyView = -1; }
        if (lobbyView < 0) return;
        Web.on(lobbyView, "quid:lobbyReady", () => {
            lobbyReady = true;
            if (lobbyLast) { try { Web.emit(lobbyView, "quid:lobby", lobbyLast); } catch (_) {} }
        });
        try { Web.showView(lobbyView); } catch (_) {}
    }
    if (!lobbyKey) {
        lobbyKey = Hmp.input.shortcuts.register({
            resource: RESOURCE, id: "lobby", key: String(data.key || "J").toLowerCase(), state: "down", priority: 40,
            when: () => lobbyView >= 0,
            handler: () => Events.emitServer("quidditch:lobbyOpen", "{}"),
        });
    }
    if (lobbyReady) { try { Web.emit(lobbyView, "quid:lobby", data); } catch (_) {} }
});

/**
 * Disconnecting never reaches quidditch:teardown — that is a SERVER event, and a client that has
 * gone does not receive one. resourceStop fires locally on disconnect, hot reload and shutdown alike.
 * Every pitch object is a server WorldObject now, so nothing in this world outlives the session.
 */
Events.on("resourceStop", (name) => {
    if (name && name !== RESOURCE) return;
    try { teardown(); } catch (_) {}
    try { closeLobbyCard(); } catch (_) {}
    try { Hmp.input.cleanup(RESOURCE); } catch (_) {}
});

logger.info("Client ready");
