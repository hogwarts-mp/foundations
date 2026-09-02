import configModule = require("./config");
import serviceModule = require("./service");
import type { HmpCore } from "../../hmp-core/types";
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpDoorPlayer } from "../types";

const { loadConfig } = configModule;
const { createDoorService } = serviceModule;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const Hmp = Imports.get<HmpLibServer<HmpDoorPlayer>>("hmp-lib");
const core = Imports.get<HmpCore<HmpDoorPlayer>>("hmp-core");
const logger = Hmp.logger.create("hmp-doors");
const config = loadConfig(Hmp);
const doors = createDoorService<HmpDoorPlayer>({ core, config, players: () => PlayerManager.getAll() });

Exports.register("policy", doors.policy);
Exports.register("grants", doors.grants);
Exports.register("status", doors.status);

function playerFromCharacterPayload(payload: unknown): HmpDoorPlayer | null {
    if (!payload || typeof payload !== "object" || !("session" in payload)) return null;
    const session = payload.session;
    return session && typeof session === "object" && "player" in session ? session.player as HmpDoorPlayer : null;
}

function safeSync(player: HmpDoorPlayer): void {
    doors.policy.sync(player).catch((error) => logger.warn(`Could not sync door policy for #${player.id}: ${messageOf(error)}`));
}

Events.onClient("hmp-doors:ready", safeSync);
Events.on("playerConnect", safeSync);
Events.on("hmp:session:ready", (session: unknown) => {
    const player = session && typeof session === "object" && "player" in session ? session.player as HmpDoorPlayer : null;
    if (player) safeSync(player);
});
Events.on("hmp:character:loaded", (payload: unknown) => { const player = playerFromCharacterPayload(payload); if (player) safeSync(player); });
Events.on("hmp:character:unloaded", (payload: unknown) => { const player = playerFromCharacterPayload(payload); if (player) safeSync(player); });
Events.on("hmp:groups:changed", () => doors.policy.syncAll().catch((error) => logger.warn(`Could not refresh door policies: ${messageOf(error)}`)));
Events.on("resourceStop", (name?: string) => { if (!name || name === "hmp-doors") doors.stop(); });

async function isAdmin(player: HmpDoorPlayer): Promise<boolean> {
    if (!config.adminGroups.length) return false;
    const checks = await Promise.all(config.adminGroups.map((group) => core.groups.has(player, group.key, group.minimumGrade || 0)));
    return checks.some(Boolean);
}

if (config.enableCommands) Events.on("chatCommand", (player: HmpDoorPlayer, _message: unknown, rawCommand: unknown, rawArgs: unknown) => {
    if (String(rawCommand || "").toLowerCase() !== config.command) return;
    const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
    const reply = (message: string) => player.sendChat?.(`[doors] ${message}`);
    void (async () => {
        if (!await isAdmin(player)) { reply("You do not have permission to manage doors."); return; }
        const action = (args.shift() || "status").toLowerCase();
        if (action === "status") {
            const resolved = await doors.policy.resolve(player);
            reply(`${resolved.policy.unlockAll ? "all physical doors unlocked" : `${resolved.policy.unlockDoors.length} named physical door(s) unlocked`}; ${resolved.policy.lockDoors.length} locked; ${resolved.policy.unlockLocks.length} logical lock(s); ${resolved.grants.length} personal grant(s)`);
            return;
        }
        if (action === "lock" || action === "unlock") {
            const selector = args.join(" ").trim();
            if (!selector) { reply(`Usage: /${config.command} ${action} <DoorActorName|/Game/...asset path>`); return; }
            player.emit("hmp-doors:diagnostic", JSON.stringify({ action: "set-locked", selector, locked: action === "lock" }));
            reply(`${action} requested for '${selector}'; this is a live diagnostic, not durable policy — use an action '${action === "lock" ? "lock" : "allow"}' rule to persist it.`);
            return;
        }
        if (action === "label") {
            const off = (args[0] || "").toLowerCase() === "off";
            player.emit("hmp-doors:diagnostic", JSON.stringify(off ? { action: "label-off" } : { action: "label", radius: Number(args[0]) || undefined }));
            reply(off ? "door labels off" : "labelling the nearest door; walk up to one.");
            return;
        }
        if (["list", "open-nearby", "unlock-nearby"].includes(action)) {
            player.emit("hmp-doors:diagnostic", JSON.stringify({ action, radius: Number(args[0]) || undefined }));
            reply(`${action} requested; see the client console for door names when listing.`);
            return;
        }
        if (action === "reload") { reply(`policy re-applied to ${await doors.policy.syncAll()} player(s)`); return; }
        if (["grant", "revoke", "grants", "clear"].includes(action)) {
            const target = Hmp.player.find(args[0] || "me", player);
            if (!target) { reply("Player not found. Use me, an exact nickname, or #id."); return; }
            if (action === "grants") { reply(`${target.nickname || `#${target.id}`}: ${(await doors.grants.list(target)).join(", ") || "none"}`); return; }
            if (action === "clear") { reply(`cleared ${await doors.grants.clear(target)} grant(s) for ${target.nickname || `#${target.id}`}`); return; }
            const name = args.slice(1).join(" ").trim();
            if (!name) { reply(`Usage: /${config.command} ${action} <me|nick|#id> <DoorActorName>`); return; }
            const changed = action === "grant" ? await doors.grants.grant(target, name) : await doors.grants.revoke(target, name);
            reply(`${changed ? action === "grant" ? "granted" : "revoked" : "no change for"} '${name}' ${action === "grant" ? "to" : "from"} ${target.nickname || `#${target.id}`}`);
            return;
        }
        reply(`Usage: /${config.command} <status|list|label|lock|unlock|open-nearby|unlock-nearby|reload|grant|revoke|grants|clear>`);
    })().catch((error) => { logger.warn(`Door command failed: ${messageOf(error)}`); reply(messageOf(error)); });
});

logger.info(`Door policy ready with ${config.rules.length} rule(s)`);
