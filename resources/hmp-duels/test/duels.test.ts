import assert = require("node:assert");
import activityModule = require("../../hmp-activities/server/service");
import pvpModule = require("../../hmp-pvp/server/service");
import duelModule = require("../server/service");
import type { HmpDuelPlayer } from "../types";

const { createActivityService } = activityModule;
const { createPvpService } = pvpModule;
const { createDuelService } = duelModule;
interface Player extends HmpDuelPlayer { area: string }
const makePlayer = (id: number, area = "Hogwarts"): Player => ({ id, nickname: `Player ${id}`, virtualWorld: 0, area, emit() {}, location() { return { areaId: this.area, regionId: "GreatHall" }; } });

async function run(): Promise<void> {
    const players = [makePlayer(1), makePlayer(2), makePlayer(3), makePlayer(4, "Overland")];
    const core = { characters: { active: (player: Player | number) => { const id = typeof player === "number" ? player : player.id; return { id: id * 10, accountId: id, slot: 1, name: `Character ${id}`, status: "active", createdAt: "", updatedAt: "", deletedAt: null }; } } };
    let sequence = 0;
    const activities = createActivityService<Player>({ core: core as never, config: { command: "activities", enableCommands: false, maxDefinitions: 10, maxSessions: 10, maxMetadataBytes: 1024, maxInvitations: 20, defaultInvitationTtlSeconds: 30, maximumInvitationTtlSeconds: 60, defaultLobbyTtlSeconds: 300, maximumLobbyTtlSeconds: 600, sweepIntervalSeconds: 30, enableTestActivity: false }, id: () => `id-${++sequence}` });
    let nativePolicy: ((hit: any) => any) | null = null;
    const pvp = createPvpService({ defaultDecision: "deny", initialLethalMode: false, install: (fn) => { nativePolicy = fn; }, clearPolicy: () => { nativePolicy = null; }, vitals: () => null, applyMode: () => undefined });
    const timers: Array<() => void> = [];
    const emitted: Array<{ player: number; event: string; payload: Record<string, unknown> }> = [];
    const pairs: Array<[number, number, unknown]> = [];
    const recovery: Array<[number, boolean]> = [];
    const delays: number[] = [];
    const stoodUp: number[] = [];
    const gearSets: Array<[number, { multiplier: number; traits: boolean }]> = [];
    let pairRoom = true;
    let kneelHeld = false;
    let gearHost = true;
    const duels = createDuelService<Player>({
        activities, pvp, player: (id) => players.find((entry) => entry.id === id) || null,
        pair: (a, b, options) => { pairs.push([a, b, options]); return pairRoom || options === null; },
        setRecovery: (id, on) => { recovery.push([id, on]); },
        kneelHeld: () => kneelHeld, endKneel: (id) => { stoodUp.push(id); },
        cosmeticGear: true,
        gearRules: (id) => !gearHost ? null : id === 2 ? { multiplier: 0.5, traits: false } : { multiplier: 1, traits: true },
        setGearRules: (id, rules) => { gearSets.push([id, rules]); },
        emit: (player, event, payload) => emitted.push({ player: player.id, event, payload }), notify() {},
        countdownSeconds: 3, invitationTtlSeconds: 30, koHp: 1,
        setTimer: ((handler: () => void, ms: number) => { timers.push(handler); delays.push(ms); return {} as NodeJS.Timeout; }), clearTimer() {},
    });
    const duel = async (a = players[0], b = players[1]) => { await duels.challenge(a, b); await duels.accept(b); timers.pop()!(); };
    const cosmetic = { multiplier: 0, traits: false };

    const challenge = await duels.challenge(players[0], players[1]);
    assert.strictEqual(activities.invitations.list().length, 1);
    await assert.rejects(duels.challenge(players[0], players[2]), /exclusive activity/);
    await assert.rejects(duels.challenge(players[2], players[3]), /game area/);
    assert.strictEqual(await duels.accept(players[1]), true);
    assert.strictEqual(activities.sessions.get(challenge.sessionId)?.state, "running");
    // The countdown reserves the pair peaceful and holds recovery off.
    assert.deepStrictEqual(pairs, [[1, 2, { hostile: false }]]);
    assert.deepStrictEqual(recovery, [[1, false], [2, false]]);
    // With cosmetic gear on, it also makes both duelists' gear count for nothing.
    assert.deepStrictEqual(gearSets, [[1, cosmetic], [2, cosmetic]]);
    const hit = { casterId: 1, victimId: 2, spellId: 1, spell: "BasicCast", damage: 10, duration: 0, victimHp: 20 };
    assert.strictEqual(nativePolicy!(hit), false);
    timers.shift()!();
    assert.deepStrictEqual(pairs.at(-1), [1, 2, { hostile: true, aim: "lock", defeat: "kneel" }]);
    assert.deepStrictEqual(nativePolicy!(hit), { minHp: 1 });
    // A finishing hit is only floored; the victim's own kneel, reported as pvpDefeat, ends the duel.
    assert.deepStrictEqual(nativePolicy!({ ...hit, damage: 25 }), { minHp: 1 });
    assert.ok(activities.sessions.get(challenge.sessionId));
    await duels.defeated(players[2], players[0]);
    assert.ok(activities.sessions.get(challenge.sessionId));
    await duels.defeated(players[1], players[0]);
    assert.strictEqual(activities.sessions.get(challenge.sessionId), null);
    assert.ok(emitted.some((entry) => entry.event === "hmp-duels:end" && entry.payload.result === "win"));
    assert.ok(emitted.some((entry) => entry.event === "hmp-duels:end" && entry.payload.result === "lose"));
    assert.deepStrictEqual(pairs.at(-1), [1, 2, null]);
    assert.deepStrictEqual(recovery.slice(-2), [[1, true], [2, true]]);
    // The end puts back each duelist's own gear rules.
    assert.deepStrictEqual(gearSets.slice(2), [[1, { multiplier: 1, traits: true }], [2, { multiplier: 0.5, traits: false }]]);
    // Rules whose kneel ends by itself, an older host's among them, leave the loser to it.
    assert.strictEqual(timers.length, 0);

    // A host with no room for another pair refuses the duel instead of starting an unprotected one.
    pairRoom = false;
    const refused = await duels.challenge(players[0], players[1]);
    await assert.rejects(duels.accept(players[1]), /no room/);
    assert.strictEqual(activities.sessions.get(refused.sessionId), null);
    pairRoom = true;

    await duels.challenge(players[0], players[1]);
    assert.strictEqual(await duels.decline(players[1]), true);
    assert.strictEqual(activities.sessions.forPlayer(players[0]).length, 0);
    // Neither a refused nor a declined challenge touched anyone's gear.
    assert.strictEqual(gearSets.length, 4);

    // A disconnected duelist's gear rules leave with them; the one still here gets theirs back.
    gearSets.length = 0;
    await duel();
    await duels.disconnected(players[1]);
    assert.deepStrictEqual(gearSets, [[1, cosmetic], [2, cosmetic], [1, { multiplier: 1, traits: true }]]);
    // A host without gear rules leaves gear as it is.
    gearHost = false; gearSets.length = 0;
    await duel();
    await duels.forfeit(players[0]);
    assert.deepStrictEqual(gearSets, []);
    gearHost = true;

    // Rules that hold kneels leave the duel to stand its loser up, after the rules' default kneel.
    kneelHeld = true;
    await duel();
    await duels.defeated(players[0], players[1]);
    assert.strictEqual(delays.at(-1), 4000);
    timers.shift()!();
    assert.deepStrictEqual(stoodUp, [1]);
    // A forfeit kneels nobody.
    await duel();
    await duels.forfeit(players[1]);
    assert.strictEqual(timers.length, 0);
    // Stopping the resource stands a loser still held down up at once, and gives a running duel's gear back.
    await duel();
    await duels.defeated(players[1], players[0]);
    assert.strictEqual(timers.length, 1);
    await duel(players[0], players[2]);
    gearSets.length = 0;
    await duels.stop(); await activities.stop(); pvp.stop();
    assert.deepStrictEqual(stoodUp, [1, 2]);
    assert.deepStrictEqual(gearSets, [[1, { multiplier: 1, traits: true }], [3, { multiplier: 1, traits: true }]]);
    assert.strictEqual(duels.status().state, "stopped");
}
run().then(() => console.log("hmp-duels tests passed"));
