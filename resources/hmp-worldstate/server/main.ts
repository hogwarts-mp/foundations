import breakablesModule = require("./breakables");
import configModule = require("./config");
import repositoryModule = require("./repository");
import schemaModule = require("./schema");
import serviceModule = require("./service");
import type { HmpCore } from "../../hmp-core/types";
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpMySQL } from "../../hmp-mysql/types";
import type { HmpWorldStatePlayer } from "../types";

const { loadConfig } = configModule;
const { createRepository } = repositoryModule;
const { createWorldStateService } = serviceModule;
const { migrations } = schemaModule;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const Hmp = Imports.get<HmpLibServer<HmpWorldStatePlayer>>("hmp-lib");
const database = Imports.get<HmpMySQL>("hmp-mysql");
const core = Imports.get<HmpCore<HmpWorldStatePlayer>>("hmp-core");
const logger = Hmp.logger.create("hmp-worldstate");
const config = loadConfig(Hmp);
const service = createWorldStateService<HmpWorldStatePlayer>({
    repository: createRepository(database),
    migrations,
    core,
    players: () => PlayerManager.getAll() as HmpWorldStatePlayer[],
    logger,
});
const breakables = breakablesModule.attach(service);
const reports = Hmp.rateLimit.create<number>({ limit: config.breakables.reportLimit.limit, windowMs: config.breakables.reportLimit.windowMs });

Exports.register("state", service.state);
Exports.register("systems", service.systems);
Exports.register("breakables", breakables);
Exports.register("status", service.status);

function playerFromCharacterPayload(payload: unknown): HmpWorldStatePlayer | null {
    if (!payload || typeof payload !== "object" || !("session" in payload)) return null;
    const session = payload.session;
    return session && typeof session === "object" && "player" in session ? session.player as HmpWorldStatePlayer : null;
}

function safeSync(player: HmpWorldStatePlayer): void {
    if (service.status().state !== "ready") return; // the resourceStart hook syncs everyone once loaded
    try { service.state.sync(player); }
    catch (error) { logger.warn(`Could not sync world state to #${player.id}: ${messageOf(error)}`); }
}

Events.onClient("hmp-worldstate:ready", safeSync);
Events.on("hmp:character:loaded", (payload: unknown) => { const player = playerFromCharacterPayload(payload); if (player) safeSync(player); });
Events.onClient("hmp-worldstate:breakable", (player: HmpWorldStatePlayer, raw: unknown) => {
    if (!config.breakables.enabled) return;
    const report = breakablesModule.parseReport(raw);
    if (!report) { logger.warn(`Dropped malformed breakable report from #${player.id}`); return; }
    if (!reports.allow(Number(player.id))) return;
    breakables.set(report.uid, report.state, { actor: player })
        .then((changed) => { if (changed) logger.info(`${player.nickname || `#${player.id}`} ${report.state} object ${report.uid}${report.cls ? ` [${report.cls}]` : ""}`); })
        .catch((error) => logger.warn(`Breakable report from #${player.id} rejected: ${messageOf(error)}`));
});
Events.on("resourceStop", (name?: string) => { if (!name || name === "hmp-worldstate") service.stop(); });
Events.on("resourceStart", (name?: string) => {
    if (name && name !== "hmp-worldstate") return;
    service.ready()
        .then(() => {
            const status = service.status();
            logger.info(`World state ready: ${status.entries} entr${status.entries === 1 ? "y" : "ies"} across ${status.systems.join(", ") || "no systems"}`);
            service.state.syncAll();
        })
        .catch((error) => logger.error(`Startup failed: ${messageOf(error)}`));
});

async function isAdmin(player: HmpWorldStatePlayer): Promise<boolean> {
    if (!config.adminGroups.length) return false;
    const checks = await Promise.all(config.adminGroups.map((group) => core.groups.has(player, group.key, group.minimumGrade || 0)));
    return checks.some(Boolean);
}

if (config.enableCommands) {
    const router = Hmp.command.createRouter({ logger });
    router.register(config.command, {
        description: "Inspect or correct persisted world state (repairable objects and other registered systems).",
        usage: `/${config.command} <status|list <system>|set <system> <key> <value>|delete <system> <key>|clear <system>|nearby [radius]|resync>`,
        guard: async ({ player }) => await isAdmin(player) || "You do not have permission to manage world state.",
    }, async (context) => {
        const { args, reply } = context;
        const action = (args[0] || "status").toLowerCase();
        if (action === "status") {
            const status = service.status();
            reply(`${status.state}; ${status.entries} entries in ${status.systems.length} system(s): ${status.systems.join(", ") || "none"}; ${status.syncedPlayers} player(s) synced`);
            return;
        }
        if (action === "list") {
            const system = (args[1] || "breakables").toLowerCase();
            if (!service.systems.has(system)) { reply(`unknown system '${system}'`); return; }
            const entries = service.state.list(system);
            reply(`${system}: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
            for (const entry of entries.slice(0, 15)) reply(`  ${entry.key} = ${entry.value}`);
            if (entries.length > 15) reply(`  … ${entries.length - 15} more`);
            return;
        }
        if (action === "set" || action === "delete") {
            const system = (args[1] || "").toLowerCase();
            const key = args[2] || "";
            const value = args.slice(3).join(" ");
            if (!system || !key || (action === "set" && !value)) { reply(context.usage); return; }
            const changed = action === "set" ? await service.state.set(system, key, value, { actor: context.player }) : await service.state.delete(system, key, { actor: context.player });
            reply(`${system}/${key} ${action === "set" ? `-> ${value}` : "deleted"}${changed ? "" : " (no change)"}`);
            return;
        }
        if (action === "clear") {
            const system = (args[1] || "").toLowerCase();
            if (!system) { reply(context.usage); return; }
            reply(`cleared ${await service.state.clear(system, { actor: context.player })} entr(ies) from ${system}`);
            return;
        }
        if (action === "nearby") {
            context.player.emit("hmp-worldstate:diagnostic", JSON.stringify({ action: "nearby", radius: Number(args[1]) || undefined }));
            reply("listing nearby repairable objects in the client console");
            return;
        }
        if (action === "resync") { reply(`world state re-sent to ${service.state.syncAll()} player(s)`); return; }
        reply(context.usage);
    });
    Events.on("chatCommand", (player: HmpWorldStatePlayer, message: string, command: string, args: string[]) => {
        void router.handle(player, message, command, args);
    });
}

logger.info(`World state loading (breakables ${config.breakables.enabled ? "on" : "off"})`);
