import catalogModule = require("../shared/catalog");
import configModule = require("./config");
import serviceModule = require("./service");
import type { HmpCore } from "../../hmp-core/types";
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpSpellLoadoutAssignments, HmpSpellPlayer } from "../types";

const { resolveSpell } = catalogModule;
const { loadConfig } = configModule;
const { createSpellService } = serviceModule;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const Hmp = Imports.get<HmpLibServer<HmpSpellPlayer>>("hmp-lib");
const core = Imports.get<HmpCore<HmpSpellPlayer>>("hmp-core");
const logger = Hmp.logger.create("hmp-spells");
const config = loadConfig(Hmp);
const spells = createSpellService<HmpSpellPlayer>({ core, config, players: () => PlayerManager.getAll(), emit: (name, ...args) => Events.emit(name, ...args) });

Exports.register("catalog", spells.catalog);
Exports.register("policy", spells.policy);
Exports.register("rules", spells.rules);
Exports.register("providers", spells.providers);
Exports.register("grants", spells.grants);
Exports.register("loadouts", spells.loadouts);
Exports.register("status", spells.status);

function playerFromCharacterPayload(payload: unknown): HmpSpellPlayer | null {
    if (!payload || typeof payload !== "object" || !("session" in payload)) return null;
    const session = payload.session;
    return session && typeof session === "object" && "player" in session ? session.player as HmpSpellPlayer : null;
}

function safeSync(player: HmpSpellPlayer): void {
    spells.policy.sync(player).catch((error) => logger.warn(`Could not sync spell policy for #${player.id}: ${messageOf(error)}`));
}

Events.onClient("hmp-spells:ready", safeSync);
Events.on("playerConnect", safeSync);
Events.on("playerDisconnect", (player: HmpSpellPlayer) => castWindows.delete(Number(player.id)));
Events.on("hmp:session:ready", (session: unknown) => {
    const player = session && typeof session === "object" && "player" in session ? session.player as HmpSpellPlayer : null;
    if (player) safeSync(player);
});
Events.on("hmp:character:loaded", (payload: unknown) => { const player = playerFromCharacterPayload(payload); if (player) safeSync(player); });
Events.on("hmp:character:unloaded", (payload: unknown) => { const player = playerFromCharacterPayload(payload); if (player) safeSync(player); });
// Character selection can complete before the client has rebuilt its native spell manager.
// Re-send after both gameplay readiness boundaries so persisted slots are restored after any
// world-load reset instead of only during the early account/character handshake.
Events.on("worldReady", safeSync);
Events.on("loadingFinished", safeSync);
Events.on("hmp:groups:changed", () => spells.policy.syncAll().catch((error) => logger.warn(`Could not refresh spell policies: ${messageOf(error)}`)));
Events.on("resourceStop", (name?: string) => {
    if (!name || name === "hmp-spells") spells.stop();
    else {
        spells.rules.clear(name);
        spells.providers.clear(name);
    }
});

function parsePayload(raw: unknown): Record<string, unknown> {
    if (typeof raw === "string") {
        try { return JSON.parse(raw) as Record<string, unknown>; }
        catch (_) { return {}; }
    }
    return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
}

Events.onClient("hmp-spells:assignments", (player: HmpSpellPlayer, raw: unknown) => {
    const payload = parsePayload(raw);
    const character = core.characters.active(player);
    if (!character || Number(payload.characterId) !== character.id) return;
    void spells.acceptClientAssignments(player, payload.assignments as HmpSpellLoadoutAssignments, {
        resource: "hmp-spells:client",
        actor: player,
        reason: "Foundations spell loadout changed",
    }).then((changed) => {
        logger.debug(`Assignments ${changed ? "persisted" : "already stored"} for character ${character.id}`);
        player.emit("hmp-spells:assignments-saved", JSON.stringify({
            characterId: character.id,
            assignments: payload.assignments,
        }));
    }).catch((error) => logger.warn(`Could not persist spell assignments for #${player.id}: ${messageOf(error)}`));
});

const castWindows = new Map<number, { startedAt: number; count: number }>();
Events.onClient("hmp-spells:cast", (player: HmpSpellPlayer, raw: unknown) => {
    const now = Date.now();
    const id = Number(player.id);
    const current = castWindows.get(id);
    const window = !current || now - current.startedAt >= 1000 ? { startedAt: now, count: 0 } : current;
    window.count++;
    castWindows.set(id, window);
    if (window.count > config.maxCastReportsPerSecond) return;
    const payload = parsePayload(raw);
    const spell = String(payload.spell || "").slice(0, 500);
    const name = String(payload.name || "").slice(0, 100);
    const lockId = resolveSpell(name);
    void spells.policy.resolve(player).then((resolution) => {
        Events.emit("hmp:spells:cast", {
            player,
            character: resolution.character,
            spell,
            name,
            lockId,
            entitled: !!lockId && resolution.policy.unlockSpells.includes(lockId),
            advisory: true,
            receivedAt: new Date(now).toISOString(),
        });
    }).catch((error) => logger.debug(`Ignored spell cast report for #${id}: ${messageOf(error)}`));
});

async function isAdmin(player: HmpSpellPlayer): Promise<boolean> {
    if (!config.adminGroups.length) return false;
    const checks = await Promise.all(config.adminGroups.map((group) => core.groups.has(player, group.key, group.minimumGrade || 0)));
    return checks.some(Boolean);
}

if (config.enableCommands) Events.on("chatCommand", (player: HmpSpellPlayer, _message: unknown, rawCommand: unknown, rawArgs: unknown) => {
    if (String(rawCommand || "").toLowerCase() !== config.command) return;
    const args = Array.isArray(rawArgs) ? rawArgs.map(String) : [];
    const reply = (message: string) => player.sendChat?.(`[spells] ${message}`);
    void (async () => {
        const action = (args.shift() || "status").toLowerCase();
        if (action === "status") {
            const resolved = await spells.policy.resolve(player);
            reply(`${resolved.policy.unlockSpells.length} spell(s), ${resolved.policy.bonusLoadouts === null ? "native loadouts unmanaged" : `${resolved.policy.bonusLoadouts} bonus loadout(s)`}, ${resolved.entitlements.spells.length} personal grant(s)`);
            return;
        }
        if (action === "list") {
            const found = spells.catalog.list(args.join(" "));
            reply(`${found.length} spell(s): ${found.slice(0, 16).map((spell) => spell.name).join(", ") || "none"}${found.length > 16 ? " …" : ""}`);
            return;
        }
        if (action === "loadout" && !args.length) {
            player.emit("hmp-spells:diagnostic", JSON.stringify({ action: "loadout" }));
            return;
        }
        if (!await isAdmin(player)) { reply("You do not have permission to manage spells."); return; }
        if (action === "reload") { reply(`policy re-applied to ${await spells.policy.syncAll()} player(s)`); return; }
        if (["grant", "revoke", "grants", "clear", "loadouts", "unmanage-loadouts"].includes(action)) {
            const target = Hmp.player.find(args[0] || "me", player);
            if (!target) { reply("Player not found. Use me, an exact nickname, or #id."); return; }
            const context = { resource: "hmp-spells:command", actor: player, reason: "closed-testing command" };
            if (action === "grants") {
                const grants = await spells.grants.list(target);
                reply(`${target.nickname || `#${target.id}`}: ${grants.map((lockId) => spells.catalog.get(lockId)?.name || lockId).join(", ") || "none"}`);
                return;
            }
            if (action === "clear") {
                const count = await spells.grants.clear(target, context);
                reply(`cleared ${count} spell grant(s) for ${target.nickname || `#${target.id}`}`);
                return;
            }
            if (action === "loadouts") {
                const count = Number(args[1]);
                if (!Number.isSafeInteger(count) || count < 0 || count > 3) { reply(`Usage: /${config.command} loadouts <me|nick|#id> <0-3>`); return; }
                const changed = await spells.loadouts.set(target, count, context);
                reply(`${changed ? "set" : "already had"} ${target.nickname || `#${target.id}`} at ${count} bonus loadout(s)`);
                return;
            }
            if (action === "unmanage-loadouts") {
                const changed = await spells.loadouts.unmanage(target, context);
                reply(`${changed ? "returned" : "already left"} ${target.nickname || `#${target.id}`} loadouts to native progression ownership`);
                return;
            }
            const spellName = args.slice(1).join(" ").trim();
            if (!spellName) { reply(`Usage: /${config.command} ${action} <me|nick|#id> <SpellName>`); return; }
            const changed = action === "grant"
                ? await spells.grants.grant(target, spellName, context)
                : await spells.grants.revoke(target, spellName, context);
            const label = spells.catalog.get(spellName)?.name || spellName;
            reply(`${changed ? action === "grant" ? "granted" : "revoked" : "no change for"} '${label}' ${action === "grant" ? "to" : "from"} ${target.nickname || `#${target.id}`}`);
            return;
        }
        reply(`Usage: /${config.command} <status|list|loadout|reload|grant|revoke|grants|clear|loadouts|unmanage-loadouts>`);
    })().catch((error) => { logger.warn(`Spell command failed: ${messageOf(error)}`); reply(messageOf(error)); });
});

logger.info(`Spell entitlement service ready with ${spells.catalog.list().length} catalog entries and ${config.rules.length} configured rule(s)`);
