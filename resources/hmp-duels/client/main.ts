// Who may hurt whom, and the loser's kneel, are the server's pair override and the native PvP pipeline;
// this client only presents the countdown, the opponent's meter and the result.
let countdownTimer: ReturnType<typeof setInterval> | null = null;

function reset(): void {
    if (countdownTimer) clearInterval(countdownTimer); countdownTimer = null;
    try { Pvp.showMeter(null); } catch (_) { /* no HUD while loading */ }
}

function parse(raw: unknown): Record<string, unknown> {
    if (typeof raw === "string") { try { return JSON.parse(raw) as Record<string, unknown>; } catch (_) { return {}; } }
    return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
}

reset();
// The server's own timer, not these numbers, makes the pair hostile.
Events.on("hmp-duels:countdown", (raw: unknown) => {
    const payload = parse(raw);
    Pvp.showMeter(Number(payload.opponentId) || 0);
    let remaining = Math.max(1, Number(payload.seconds) || 3);
    Game.notify(`Duel against ${String(payload.opponentName || "opponent")} begins in ${remaining}…`);
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => { remaining--; if (remaining <= 0) { clearInterval(countdownTimer!); countdownTimer = null; } else Game.notify(String(remaining)); }, 1000);
});
Events.on("hmp-duels:start", (raw: unknown) => {
    Pvp.showMeter(Number(parse(raw).opponentId) || 0);
    if (countdownTimer) clearInterval(countdownTimer); countdownTimer = null;
    Game.notify("Duel!");
});
// A loser is already kneeling: the finishing hit's own defeat, which stands them back up by itself, or the server
// does when its rules hold kneels.
Events.on("hmp-duels:end", (raw: unknown) => {
    const payload = parse(raw); const result = String(payload.result || "cancelled");
    const opponent = String(payload.opponentName || "your opponent");
    reset();
    if (result === "lose") Game.notify(`Defeated — ${opponent} wins`);
    else Game.notify(result === "win" ? `Victory over ${opponent}!` : `Duel ended: ${String(payload.reason || result)}`);
});
Events.on("resourceStop", (name?: string) => { if (!name || name === "hmp-duels") reset(); });
console.info("[hmp-duels] native duel coordinator ready");
