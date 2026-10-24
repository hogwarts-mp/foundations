import serviceModule = require("./service");
import type { HmpActivities } from "../../hmp-activities/types";
import type { HmpCore } from "../../hmp-core/types";
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpPvp } from "../../hmp-pvp/types";
import type { HmpUiServer } from "../../hmp-ui/types";
import type { HmpDuelPlayer } from "../types";

const { createDuelService } = serviceModule;
const Hmp = Imports.get<HmpLibServer<HmpDuelPlayer>>("hmp-lib");
const core = Imports.get<HmpCore<HmpDuelPlayer>>("hmp-core");
const activities = Imports.get<HmpActivities<HmpDuelPlayer>>("hmp-activities");
const pvp = Imports.get<HmpPvp>("hmp-pvp");
const ui = Imports.get<HmpUiServer<HmpDuelPlayer>>("hmp-ui");
const logger = Hmp.logger.create("hmp-duels");
const loaded = Hmp.config.load<{ command: string; enableCommands: boolean; countdownSeconds: number; invitationTtlSeconds: number; koHp: number; cosmeticGear: boolean } & Record<string, unknown>>(process.env.HMP_DUELS_CONFIG || "data/hmp-duels.json", { defaults: { command: "duel", enableCommands: true, countdownSeconds: 3, invitationTtlSeconds: 30, koHp: 1, cosmeticGear: false } });
const command = String(loaded.command || "duel").trim().toLowerCase();
const countdownSeconds = Math.max(1, Math.min(10, Math.floor(Number(loaded.countdownSeconds) || 3)));
const invitationTtlSeconds = Math.max(10, Math.min(300, Math.floor(Number(loaded.invitationTtlSeconds) || 30)));
const koHp = Math.max(1, Math.min(100, Number(loaded.koHp) || 1));
const duels = createDuelService({
    activities, pvp, countdownSeconds, invitationTtlSeconds, koHp,
    player: (id) => PlayerManager.getById(id),
    pair: (a, b, options) => Pvp.setPair(a, b, options),
    setRecovery: (id, on) => { try { PlayerManager.getById(id)?.setHealthRecovery?.(on); } catch (_) { /* left mid-duel */ } },
    // An older host's rules have no kneelSeconds, and its kneel always ends by itself.
    kneelHeld: () => Pvp.getRules().kneelSeconds === 0,
    endKneel: (id) => { try { PlayerManager.getById(id)?.endKneel?.(); } catch (_) { /* left while kneeling */ } },
    cosmeticGear: loaded.cosmeticGear === true,
    // An older host has no gear rules, and worn gear counts as it always has.
    gearRules: (id) => {
        const player = PlayerManager.getById(id);
        if (typeof player?.setGearStatMultiplier !== "function" || typeof player.setGearTraits !== "function") return null;
        return { multiplier: Number(player.gearStatMultiplier ?? 1), traits: player.gearTraits !== false };
    },
    setGearRules: (id, rules) => {
        const player = PlayerManager.getById(id);
        try { player?.setGearStatMultiplier?.(rules.multiplier); player?.setGearTraits?.(rules.traits); }
        catch (_) { /* left mid-duel */ }
    },
    emit: (player, event, payload) => player.emit(event, JSON.stringify(payload)),
    notify: (player, message, tone = "inform") => { ui.notify(player, { title: "Wizard's duel", description: message, tone }); },
    warn: (message) => logger.warn(message),
});

for (const name of ["challenge", "accept", "decline", "cancel", "forfeit", "status"] as const) Exports.register(name, duels[name]);

async function promptChallenge(target: HmpDuelPlayer, challenger: HmpDuelPlayer): Promise<void> {
    const answer = await ui.alert(target, {
        title: "Wizard's duel",
        content: `${challenger.nickname} challenges you to a non-lethal duel. The loser kneels; nobody dies.`,
        confirmLabel: "Accept", cancelLabel: "Decline", cancel: true, timeoutMs: invitationTtlSeconds * 1000,
    });
    if (answer === "confirm") {
        if (await duels.accept(target)) ui.notify(target, { title: "Wizard's duel", description: "Challenge accepted.", tone: "success" });
    } else await duels.decline(target, answer === null ? "challenge expired" : "challenge declined");
}

if (loaded.enableCommands !== false) Events.on("chatCommand", (player: HmpDuelPlayer, _message: unknown, rawCommand: unknown, rawArgs: unknown) => {
    if (String(rawCommand || "").toLowerCase() !== command) return;
    const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
    const reply = (message: string) => player.sendChat?.(`[duels] ${message}`);
    void (async () => {
        const action = String(args[0] || "").toLowerCase();
        if (action === "accept") { ui.close(player, "challenge answered"); reply(await duels.accept(player) ? "challenge accepted" : "no pending challenge"); return; }
        if (action === "decline") { ui.close(player, "challenge answered"); reply(await duels.decline(player) ? "challenge declined" : "no pending challenge"); return; }
        if (action === "cancel") { reply(await duels.cancel(player) ? "challenge withdrawn" : "no outgoing challenge"); return; }
        if (action === "forfeit") { reply(await duels.forfeit(player) ? "duel forfeited" : "you are not in a duel"); return; }
        if (action === "status") { const status = duels.status(); reply(`${status.pending} pending, ${status.countdowns} countdown, ${status.live} live`); return; }
        const target = action ? Hmp.player.find(args.join(" "), player) : null;
        if (!target || target.id === player.id) { reply(`Usage: /${command} <#playerId|nickname> | accept | decline | cancel | forfeit | status`); return; }
        const challenge = await duels.challenge(player, target);
        reply(`challenge sent to ${target.nickname}; expires ${new Date(challenge.expiresAt).toLocaleTimeString()}`);
        void promptChallenge(target, player).catch((error) => logger.warn(`Challenge prompt failed: ${error instanceof Error ? error.message : String(error)}`));
    })().catch((error) => reply(error instanceof Error ? error.message : String(error)));
});

Events.on("hmp:activities:invitation:expired", (payload: unknown) => { void duels.expired(payload); });
Events.on("pvpDefeat", (victim: HmpDuelPlayer, killer: HmpDuelPlayer) => { void duels.defeated(victim, killer); });
Events.on("playerDied", (player: HmpDuelPlayer) => { void duels.died(player); });
Events.on("playerDisconnect", (player: HmpDuelPlayer) => { void duels.disconnected(player); });
Events.on("resourceStop", (name?: string) => { if (!name || name === "hmp-duels") void duels.stop(); });
logger.info("Consensual non-lethal duel service ready");
