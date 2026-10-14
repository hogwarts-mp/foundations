import type { HmpActivities, HmpActivityInvitation, HmpActivitySession } from "../../hmp-activities/types";
import type { HmpPvp, HmpPvpHit } from "../../hmp-pvp/types";
import type { HmpDuelChallenge, HmpDuelPlayer, HmpDuels } from "../types";

interface Dependencies<P extends HmpDuelPlayer> {
    activities: HmpActivities<P>;
    pvp: HmpPvp;
    player(id: number): P | null;
    /** The host's pair override (Pvp.setPair); null clears it. False when the host has no room. */
    pair(a: number, b: number, options: { hostile: boolean; aim?: "lock" | "skillshot"; defeat?: "death" | "kneel" } | null): boolean;
    setRecovery(playerId: number, on: boolean): void;
    emit(player: P, event: string, payload: Record<string, unknown>): void;
    notify(player: P, message: string, tone?: "inform" | "success" | "warning" | "error"): void;
    countdownSeconds: number;
    invitationTtlSeconds: number;
    koHp: number;
    now?: () => number;
    setTimer?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
    warn?(message: string): void;
}

// A live duel is a pair override: lock-on and a kneel finish, whatever the server's own rules say.
const DUEL = { hostile: true, aim: "lock", defeat: "kneel" } as const;
// The countdown reserves the pair but holds it peaceful, even on an open-PvP server.
const COUNTDOWN = { hostile: false } as const;

function createDuelService<P extends HmpDuelPlayer>(dependencies: Dependencies<P>): HmpDuels<P> & {
    defeated(victim: P, killer: P): Promise<void>;
    expired(payload: unknown): Promise<void>;
    died(player: P): Promise<void>;
    disconnected(player: P): Promise<void>;
    stop(): Promise<void>;
} {
    const { activities, pvp } = dependencies;
    const now = dependencies.now || Date.now;
    const schedule = dependencies.setTimer || setTimeout;
    const unschedule = dependencies.clearTimer || clearTimeout;
    const startedAt = now();
    const active = new Map<number, { opponentId: number; sessionId: string }>();
    const live = new Set<string>();
    const ending = new Set<string>();
    const countdowns = new Map<string, ReturnType<typeof setTimeout>>();
    let state: "ready" | "stopped" = "ready";
    const pairKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
    const duelInvitations = (playerId: number, direction: "incoming" | "outgoing") => activities.invitations.list({ playerId, direction }).filter((invite) => invite.activityId === "duel:standard");

    function emitTo(playerId: number, event: string, payload: Record<string, unknown>): void {
        const player = dependencies.player(playerId); if (player) dependencies.emit(player, event, payload);
    }

    function teardown(session: HmpActivitySession, result?: Record<string, unknown>, reason = "cancelled"): void {
        const timer = countdowns.get(session.id); if (timer) unschedule(timer);
        countdowns.delete(session.id);
        const ids = [...new Set([
            ...session.participants.map((entry) => entry.playerId),
            Number(result?.winnerId) || 0,
            Number(result?.loserId) || 0,
        ].filter(Boolean))];
        // Only a duel that began holds a pair and recovery; a refused or expired challenge never touched either.
        const began = ids.filter((id) => active.has(id));
        for (const id of ids) active.delete(id);
        for (const id of began) dependencies.setRecovery(id, true);
        if (ids.length >= 2) {
            live.delete(pairKey(ids[0], ids[1])); ending.delete(pairKey(ids[0], ids[1]));
            if (began.length) dependencies.pair(ids[0], ids[1], null);
        }
        const winnerId = Number(result?.winnerId) || 0;
        const loserId = Number(result?.loserId) || 0;
        for (const participant of session.participants) {
            const outcome = winnerId === participant.playerId ? "win" : loserId === participant.playerId ? "lose" : "cancelled";
            const opponent = session.participants.find((entry) => entry.playerId !== participant.playerId);
            emitTo(participant.playerId, "hmp-duels:end", { result: outcome, reason: String(result?.reason || reason), opponentId: opponent?.playerId || 0, opponentName: opponent?.nickname || "?" });
        }
    }

    const disposeDefinition = activities.definitions.register({
        id: "duel:standard", resource: "hmp-duels", label: "Wizard duel",
        description: "A consensual, non-lethal one-on-one wizard duel.", minimumPlayers: 2, maximumPlayers: 2,
        requireReady: false, requiresCharacter: true, exclusive: true, disconnectPolicy: "remove",
        defaultVisibility: "private", scope: "areaAndVirtualWorld", lobbyTtlSeconds: Math.max(30, dependencies.invitationTtlSeconds + 10),
        onCompleted: ({ session, result, reason }) => teardown(session, result, reason),
        onCancelled: ({ session, reason }) => teardown(session, undefined, reason),
    });

    async function finish(winnerId: number, loserId: number, reason: string): Promise<void> {
        const match = active.get(winnerId) || active.get(loserId); if (!match) return;
        const key = pairKey(winnerId, loserId); if (ending.has(key)) return;
        ending.add(key); live.delete(key);
        try { await activities.sessions.complete(match.sessionId, { winnerId, loserId, reason }, { resource: "hmp-duels", reason }); }
        catch (error) { ending.delete(key); dependencies.warn?.(`Could not finish duel '${match.sessionId}': ${error instanceof Error ? error.message : String(error)}`); }
    }

    // The pair's kneel defeat floors each hit at kneelHp on the victim's live health; this sets the duel's own floor.
    // The victim's client kneels on the finishing hit and the host reports it as pvpDefeat, which ends the duel.
    const disposePolicy = pvp.policy.register({
        id: "duels", resource: "hmp-duels", priority: 1000,
        decide(hit: Readonly<HmpPvpHit>) {
            const match = active.get(hit.victimId);
            if (!match || match.opponentId !== hit.casterId) return undefined;
            const key = pairKey(hit.casterId, hit.victimId);
            if (!live.has(key) || ending.has(key)) return false;
            return { minHp: dependencies.koHp };
        },
    });

    async function begin(session: HmpActivitySession): Promise<void> {
        const [left, right] = session.participants;
        if (!left || !right) throw new Error("A duel requires exactly two players");
        if (!dependencies.pair(left.playerId, right.playerId, COUNTDOWN)) throw new Error("The server has no room for another duel right now");
        active.set(left.playerId, { opponentId: right.playerId, sessionId: session.id });
        active.set(right.playerId, { opponentId: left.playerId, sessionId: session.id });
        dependencies.setRecovery(left.playerId, false);
        dependencies.setRecovery(right.playerId, false);
        emitTo(left.playerId, "hmp-duels:countdown", { seconds: dependencies.countdownSeconds, opponentId: right.playerId, opponentName: right.nickname });
        emitTo(right.playerId, "hmp-duels:countdown", { seconds: dependencies.countdownSeconds, opponentId: left.playerId, opponentName: left.nickname });
        // Not unref'd: each resource runs its own event loop, and libuv skips the timers of a loop with nothing referenced.
        const timer = schedule(() => {
            countdowns.delete(session.id);
            const current = activities.sessions.get(session.id);
            if (!current || active.get(left.playerId)?.opponentId !== right.playerId) return;
            live.add(pairKey(left.playerId, right.playerId));
            dependencies.pair(left.playerId, right.playerId, DUEL);
            emitTo(left.playerId, "hmp-duels:start", { opponentId: right.playerId, opponentName: right.nickname });
            emitTo(right.playerId, "hmp-duels:start", { opponentId: left.playerId, opponentName: left.nickname });
        }, dependencies.countdownSeconds * 1000);
        countdowns.set(session.id, timer);
    }

    async function challenge(challenger: P, target: P): Promise<HmpDuelChallenge> {
        if (state === "stopped") throw new Error("hmp-duels is stopped");
        if (Number(challenger.id) === Number(target.id)) throw new Error("You cannot challenge yourself");
        if (activities.sessions.forPlayer(target).length) throw new Error(`${target.nickname} is already in an activity`);
        let session: HmpActivitySession | null = null;
        try {
            session = await activities.sessions.create(challenger, "duel:standard", { title: `${challenger.nickname} vs ${target.nickname}`, visibility: "private" });
            const invitation = await activities.invitations.invite(session.id, target, { message: `${challenger.nickname} challenges you to a non-lethal duel.`, ttlSeconds: dependencies.invitationTtlSeconds }, { actor: challenger });
            return { sessionId: session.id, invitationId: invitation.id, challengerId: challenger.id, targetId: target.id, expiresAt: invitation.expiresAt };
        } catch (error) {
            if (session && activities.sessions.get(session.id)) await activities.sessions.cancel(session.id, { resource: "hmp-duels", reason: "challenge setup failed" }).catch(() => undefined);
            throw error;
        }
    }

    async function answer(target: P, accept: boolean, reason = "declined"): Promise<boolean> {
        const invitations = duelInvitations(Number(target.id), "incoming");
        if (invitations.length !== 1) return false;
        const invitation = invitations[0];
        if (!accept) {
            await activities.invitations.decline(target, invitation.id, reason);
            if (activities.sessions.get(invitation.sessionId)) await activities.sessions.cancel(invitation.sessionId, { resource: "hmp-duels", reason });
            return true;
        }
        try {
            const joined = await activities.invitations.accept(target, invitation.id);
            const running = await activities.sessions.start(joined.id, { resource: "hmp-duels", reason: "challenge accepted" });
            await begin(running); return true;
        } catch (error) {
            if (activities.sessions.get(invitation.sessionId)) await activities.sessions.cancel(invitation.sessionId, { resource: "hmp-duels", reason: "challenge acceptance failed" }).catch(() => undefined);
            throw error;
        }
    }

    async function cancel(challenger: P): Promise<boolean> {
        const invitations = duelInvitations(Number(challenger.id), "outgoing");
        if (invitations.length !== 1) return false;
        const invitation = invitations[0];
        await activities.invitations.cancel(invitation.id, { actor: challenger, reason: "challenge withdrawn" });
        if (activities.sessions.get(invitation.sessionId)) await activities.sessions.cancel(invitation.sessionId, { actor: challenger, reason: "challenge withdrawn" });
        return true;
    }

    async function forfeit(player: P): Promise<boolean> {
        const match = active.get(Number(player.id)); if (!match) return false;
        await finish(match.opponentId, Number(player.id), "forfeit"); return true;
    }

    async function expired(payload: unknown): Promise<void> {
        if (!payload || typeof payload !== "object" || !("invitation" in payload)) return;
        const invitation = (payload as { invitation?: HmpActivityInvitation }).invitation;
        if (!invitation || invitation.activityId !== "duel:standard") return;
        if (activities.sessions.get(invitation.sessionId)) await activities.sessions.cancel(invitation.sessionId, { resource: "hmp-duels", reason: "challenge expired" });
    }

    // The host only reports a defeat from a caster whose accepted hit could have caused it.
    async function defeated(victim: P, killer: P): Promise<void> {
        const victimId = Number(victim.id), killerId = Number(killer.id);
        if (active.get(victimId)?.opponentId !== killerId || !live.has(pairKey(victimId, killerId))) return;
        await finish(killerId, victimId, "ko");
    }

    async function died(player: P): Promise<void> { const match = active.get(Number(player.id)); if (match) await finish(match.opponentId, Number(player.id), "died"); }
    async function disconnected(player: P): Promise<void> { const match = active.get(Number(player.id)); if (match) await finish(match.opponentId, Number(player.id), "disconnect"); }
    async function stop(): Promise<void> {
        if (state === "stopped") return; state = "stopped"; disposePolicy();
        for (const timer of countdowns.values()) unschedule(timer); countdowns.clear();
        await disposeDefinition(); active.clear(); live.clear(); ending.clear();
    }

    return Object.freeze({ challenge, accept: (player: P) => answer(player, true), decline: (player: P, reason?: string) => answer(player, false, reason), cancel, forfeit, status: () => ({ state, pending: activities.invitations.list().filter((entry) => entry.activityId === "duel:standard").length, countdowns: countdowns.size, live: live.size, uptimeMs: now() - startedAt }), defeated, expired, died, disconnected, stop });
}

export = { createDuelService };
