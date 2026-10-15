import configModule = require("./config");
import serviceModule = require("./service");
import type { HmpCore } from "../../hmp-core/types";
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpActivityPlayer, HmpActivitySession } from "../types";

const { loadConfig } = configModule;
const { createActivityService } = serviceModule;
const Hmp = Imports.get<HmpLibServer<HmpActivityPlayer>>("hmp-lib");
const core = Imports.get<HmpCore<HmpActivityPlayer>>("hmp-core");
const logger = Hmp.logger.create("hmp-activities");
const config = loadConfig(Hmp);
const activities = createActivityService({
    core, config,
    emit: (name, payload) => Events.emit(name, payload),
    warn: (message) => logger.warn(message),
});

Exports.register("definitions", activities.definitions);
Exports.register("sessions", activities.sessions);
Exports.register("invitations", activities.invitations);
Exports.register("status", activities.status);

if (config.enableTestActivity) activities.definitions.register({
    id: "foundations:test-party",
    resource: "hmp-activities",
    label: "Foundations test party",
    description: "A non-gameplay role-composition probe for closed testing.",
    minimumPlayers: 2,
    maximumPlayers: 5,
    requireReady: true,
    scope: "areaAndVirtualWorld",
    roles: [
        { id: "healer", label: "Healer", min: 1, max: 1 },
        { id: "caster", label: "Caster", min: 1, max: 3 },
        { id: "fighter", label: "Fighter", min: 0, max: 3 },
    ],
});

function short(session: HmpActivitySession): string { return session.id.split(":").at(-1)!.slice(0, 8); }
function label(session: HmpActivitySession): string {
    const roles = session.composition.map((slot) => `${slot.label} ${slot.filled}/${slot.maximum}`).join(", ");
    return `${short(session)} ${session.title} (${session.participants.length}/${session.maximumPlayers}${roles ? `; ${roles}` : ""})${session.startable ? " [startable]" : ""}`;
}
function resolveSession(query: string, player?: HmpActivityPlayer): HmpActivitySession | null {
    const candidates = (query ? activities.sessions.list() : player ? activities.sessions.forPlayer(player) : [])
        .filter((session) => !query || session.id === query || session.id.startsWith(query) || session.id.split(":").at(-1)!.startsWith(query));
    return candidates.length === 1 ? candidates[0] : null;
}

Events.on("playerDisconnect", (player: HmpActivityPlayer) => {
    activities.disconnect(player).catch((error) => logger.warn(`Disconnect cleanup failed for #${player.id}: ${error instanceof Error ? error.message : String(error)}`));
});

// Not unref'd: each resource runs its own event loop, and libuv skips the timers of a loop with nothing referenced.
const sweeper = setInterval(() => {
    activities.sweep().catch((error) => logger.warn(`Expiry sweep failed: ${error instanceof Error ? error.message : String(error)}`));
}, config.sweepIntervalSeconds * 1000);

Events.on("resourceStop", (name?: string) => {
    if (!name || name === "hmp-activities") {
        clearInterval(sweeper);
        activities.stop().catch((error) => logger.error(`Shutdown failed: ${error instanceof Error ? error.message : String(error)}`));
    } else activities.cleanup(name).catch((error) => logger.warn(`Could not clean up '${name}': ${error instanceof Error ? error.message : String(error)}`));
});

if (config.enableCommands) Events.on("chatCommand", (player: HmpActivityPlayer, _message: unknown, rawCommand: unknown, rawArgs: unknown) => {
    if (String(rawCommand || "").toLowerCase() !== config.command) return;
    const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
    const reply = (message: string) => player.sendChat?.(`[activities] ${message}`);
    void (async () => {
        const action = (args.shift() || "list").toLowerCase();
        if (action === "definitions") {
            const entries = activities.definitions.list();
            reply(`${entries.length} definition(s): ${entries.map((entry) => `${entry.id} (${entry.minimumPlayers}-${entry.maximumPlayers})`).join(", ") || "none"}`);
            return;
        }
        if (action === "list") {
            const entries = activities.sessions.discover(player);
            if (!entries.length) reply("No public forming activities match your current area and virtual world.");
            else entries.slice(0, 12).forEach((session) => reply(label(session)));
            return;
        }
        if (action === "mine") {
            const entries = activities.sessions.forPlayer(player);
            if (!entries.length) reply("You are not in an activity."); else entries.forEach((session) => reply(label(session)));
            return;
        }
        if (action === "create") {
            if (!args[0]) { reply(`Usage: /${config.command} create <activityId> [role] [team]`); return; }
            const session = await activities.sessions.create(player, args[0], { role: args[1], team: args[2] });
            reply(`Created ${label(session)}. Other players can join with /${config.command} join ${short(session)} <role>.`);
            return;
        }
        if (action === "join") {
            const session = resolveSession(args[0]);
            if (!session) { reply("Session not found or prefix is ambiguous. Use /activities list."); return; }
            reply(`Joined ${label(await activities.sessions.join(player, session.id, { role: args[1], team: args[2] }))}`);
            return;
        }
        const session = resolveSession(args[0] || "", player);
        if (!session) { reply("Your activity was not found, or the supplied prefix is ambiguous."); return; }
        if (args[0]) args.shift();
        if (action === "leave") { await activities.sessions.leave(player, session.id); reply("Left the activity."); return; }
        if (action === "ready" || action === "unready") { reply(label(await activities.sessions.setReady(player, session.id, action === "ready"))); return; }
        if (action === "role") { if (!args[0]) { reply(`Usage: /${config.command} role [session] <role> [team]`); return; } reply(label(await activities.sessions.select(player, session.id, { role: args[0], team: args[1] }))); return; }
        if (action === "start") { reply(`Started ${label(await activities.sessions.start(session.id, { actor: player, reason: "closed-testing command" }))}`); return; }
        if (action === "cancel") { await activities.sessions.cancel(session.id, { actor: player, reason: "cancelled by leader" }); reply("Cancelled the activity."); return; }
        if (action === "status") { reply(label(session)); return; }
        reply(`Usage: /${config.command} <definitions|list|mine|create|join|leave|role|ready|unready|start|cancel|status>`);
    })().catch((error) => reply(error instanceof Error ? error.message : String(error)));
});

logger.info(`Activity session service ready with ${activities.definitions.list().length} definition(s)`);
