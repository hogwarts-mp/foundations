import configModule = require("./config");
import repositoryModule = require("./repository");
import schemaModule = require("./schema");
import serviceModule = require("./service");
import type { HmpCore } from "../../hmp-core/types";
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpMySQL } from "../../hmp-mysql/types";
import type { HmpLootItem, HmpLootPlayer } from "../types";
import type { NativeLootables, NativeWorldLoot } from "./internal";

declare const Lootables: NativeLootables<HmpLootPlayer> | undefined;
declare const World: NativeWorldLoot | undefined;

const { loadConfig } = configModule;
const { createRepository } = repositoryModule;
const { createLootService } = serviceModule;
const { migrations } = schemaModule;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const Hmp = Imports.get<HmpLibServer<HmpLootPlayer>>("hmp-lib");
const database = Imports.get<HmpMySQL>("hmp-mysql");
const core = Imports.get<HmpCore<HmpLootPlayer>>("hmp-core");
const logger = Hmp.logger.create("hmp-loot");
const config = loadConfig(Hmp);
// A server build without the builtins degrades at startup instead of failing to load.
const native = typeof Lootables === "undefined" || typeof World === "undefined" || typeof World.suppressLoot !== "function" ? null : { lootables: Lootables, world: World };
const missing = {
    place: () => { throw new Error("this server build has no Lootables builtin"); },
    setItems: () => false, setView: () => false, remove: () => false,
    lootSuppressed: { chests: false, moonstones: false, foragables: false },
    suppressLoot: () => false,
};
const service = createLootService<HmpLootPlayer>({
    config,
    lootables: native?.lootables ?? missing,
    world: native?.world ?? missing,
    repository: createRepository(database),
    migrations,
    core,
    players: () => PlayerManager.getAll() as HmpLootPlayer[],
    logger,
});

Exports.register("lootables", service.lootables);
Exports.register("status", service.status);

// hmp:session:ready carries the session itself; the character events carry { session, character }.
function playerFromPayload(payload: unknown): HmpLootPlayer | null {
    if (!payload || typeof payload !== "object") return null;
    const session = "session" in payload ? payload.session : payload;
    return session && typeof session === "object" && "player" in session ? session.player as HmpLootPlayer : null;
}

function safeSync(player: HmpLootPlayer | null): void {
    if (!player) return;
    try { service.sync(player); }
    catch (error) { logger.warn(`Could not apply loot views to #${player.id}: ${messageOf(error)}`); }
}

Events.on("lootableTaken", (player: HmpLootPlayer, lootableId: number, items: HmpLootItem[]) => {
    service.taken(player, lootableId, items).catch((error) => logger.warn(`Could not record a take of lootable ${lootableId} by #${player.id}: ${messageOf(error)}`));
});
Events.on("playerConnect", (player: HmpLootPlayer) => safeSync(player));
Events.on("hmp:session:ready", (payload: unknown) => safeSync(playerFromPayload(payload)));
Events.on("hmp:character:loaded", (payload: unknown) => safeSync(playerFromPayload(payload)));
Events.on("hmp:character:unloaded", (payload: unknown) => safeSync(playerFromPayload(payload)));
Events.on("resourceStop", (name?: string) => { if (!name || name === "hmp-loot") service.stop(); });
Events.on("resourceStart", (name?: string) => {
    if (name && name !== "hmp-loot") return;
    if (!native) logger.error("This server build has no Lootables builtin; no loot is placed.");
    service.ready()
        .then(() => {
            const status = service.status();
            const off = Object.entries(status.suppressedGameLoot).filter(([, on]) => on).map(([family]) => family);
            logger.info(`Loot ready: ${status.lootables} lootable(s), ${status.records} live take(s); game loot off: ${off.join(", ") || "none"}`);
        })
        .catch((error) => logger.error(`Startup failed: ${messageOf(error)}`));
});

async function isAdmin(player: HmpLootPlayer): Promise<boolean> {
    if (!config.adminGroups.length) return false;
    const checks = await Promise.all(config.adminGroups.map((group) => core.groups.has(player, group.key, group.minimumGrade || 0)));
    return checks.some(Boolean);
}

if (config.enableCommands) {
    const router = Hmp.command.createRouter({ logger });
    router.register(config.command, {
        description: "Inspect configured loot and reset takes.",
        usage: `/${config.command} <status|list|reset <key> [characterId]>`,
        guard: async ({ player }) => await isAdmin(player) || "You do not have permission to manage loot.",
    }, async (context) => {
        const { args, reply } = context;
        const action = (args[0] || "status").toLowerCase();
        if (action === "status") {
            const status = service.status();
            reply(`${status.state}${status.lastError ? ` (${status.lastError})` : ""}; ${status.lootables} lootable(s), ${status.records} live take(s)`);
            return;
        }
        if (action === "list") {
            const all = service.lootables.list();
            reply(`${all.length} lootable(s)`);
            for (const entry of all.slice(0, 15)) {
                const respawn = entry.respawnSeconds === null ? "never respawns" : `respawns after ${entry.respawnSeconds} s`;
                reply(`  ${entry.key}: ${entry.kind}, ${entry.scope}, ${respawn}${entry.taken ? ", taken" : ""}${entry.lootableId ? "" : ", NOT PLACED"}`);
            }
            if (all.length > 15) reply(`  … ${all.length - 15} more`);
            return;
        }
        if (action === "reset") {
            const key = args[1] || "";
            if (!key) { reply(context.usage); return; }
            const characterId = args[2] === undefined ? undefined : Number(args[2]);
            if (characterId !== undefined && !Number.isSafeInteger(characterId)) { reply(context.usage); return; }
            try { reply(`ended ${await service.lootables.reset(key, characterId)} take(s) of ${key}`); }
            catch (error) { reply(messageOf(error)); }
            return;
        }
        reply(context.usage);
    });
    Events.on("chatCommand", (player: HmpLootPlayer, message: string, command: string, args: string[]) => {
        void router.handle(player, message, command, args);
    });
}

logger.info(`Loot loading: ${config.lootables.length} configured lootable(s)`);
