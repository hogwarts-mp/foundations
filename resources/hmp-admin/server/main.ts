import configModule = require("./config");
import permissionsModule = require("./permissions");
import repositoryModule = require("./repository");
import schemaModule = require("./schema");
import serviceModule = require("./service");
import uiModule = require("./ui");
import type { HmpCoreSession } from "../../hmp-core/types";
import type { Player } from "./internal";

const { loadConfig } = configModule;
const { createPermissions } = permissionsModule;
const { createRepository } = repositoryModule;
const { migrations } = schemaModule;
const { createAdminService } = serviceModule;
const { createAdminUi } = uiModule;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const Hmp = Imports.get("hmp-lib");
const database = Imports.get("hmp-mysql");
const core = Imports.get("hmp-core");
const ui = Imports.get("hmp-ui");
const inventory = Imports.get("hmp-inventory");
const characters = Imports.get("hmp-characters");
const banking = Imports.get("hmp-banking");
const jobs = Imports.get("hmp-jobs");
const spells = Imports.get("hmp-spells");
const world = Imports.get("hmp-world");
const logger = Hmp.logger.create("hmp-admin");
const config = loadConfig(Hmp);
const repository = createRepository(database);
const permissions = createPermissions({ core, config });
const admin = createAdminService({
    repository, permissions, core, inventory, banking, characters, jobs, spells, world, config, logger, migrations,
    listPlayers: () => PlayerManager.getAll(),
    getPlayer: (id) => PlayerManager.getById(id) || PlayerManager.getAll().find((player) => player.id === id) || null,
});
const adminUi = createAdminUi({ admin, ui, banking, inventory, spells });

for (const name of ["permissions", "players", "actions", "moderation", "audit", "status"] as const) Exports.register(name, admin[name]);
Exports.register("ui", adminUi);

Events.on("hmp:session:ready", (session: unknown) => {
    admin.onSessionReady(session as HmpCoreSession<Player>).catch((error: unknown) => logger.error(`Ban check failed: ${messageOf(error)}`));
});
Events.on("playerDisconnect", (player: Player) => { adminUi.close(player); admin.disconnect(player); });
Events.on("hmp:session:ended", (session: unknown) => { const player = (session as HmpCoreSession<Player>)?.player; if (player) { adminUi.close(player); admin.disconnect(player); } });
Events.on("hmp:groups:changed", () => { admin.revalidateNoclip().catch((error: unknown) => logger.error(`No-clip permission refresh failed: ${messageOf(error)}`)); });
Events.on("playerTeleportComplete", (player: Player, requestId: number, status: number, completion: HogwartsMpTeleportCompletion) => admin.onTeleportComplete(player, requestId, status, completion));

if (config.command) {
    const commands = Hmp.command.createRouter({ logger, prefix: "[admin]" });
    commands.register(config.command, { description: "Open the HMP administration menu." }, ({ player }) => adminUi.open(player));
    Events.on("chatCommand", commands.handle);
}

Events.on("resourceStop", (name?: string) => {
    if (!name || name === "hmp-admin") admin.stop().catch((error: unknown) => logger.error(`Shutdown failed: ${messageOf(error)}`));
});

Events.on("resourceStart", async (name?: string) => {
    if (name && name !== "hmp-admin") return;
    await admin.ready();
    if (config.bootstrapSecret) logger.warn("Closed-test bootstrap access is enabled. Remove HMP_ADMIN_BOOTSTRAP_SECRET after verified staff identities are available.");
    if (config.allowUnsafeAssertedBans) logger.warn("Unsafe asserted-identity bans are enabled. This must not be used in production.");
    logger.info("Moderation, administration, recovery, and audit services ready");
});
