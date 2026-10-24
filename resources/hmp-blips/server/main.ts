import configModule = require("./config");
import serviceModule = require("./service");
import type { HmpCore } from "../../hmp-core/types";
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpBlipPlayer } from "../types";

const { loadConfig } = configModule;
const { createBlipsService } = serviceModule;
const Hmp = Imports.get<HmpLibServer<HmpBlipPlayer>>("hmp-lib");
const core = Imports.get<HmpCore<HmpBlipPlayer>>("hmp-core");
const logger = Hmp.logger.create("hmp-blips");
const config = loadConfig(Hmp);
const blips = createBlipsService({ core, config, players: () => PlayerManager.getAll(), events: Events, logger });

for (const name of ["markers", "players", "waypoints", "status"] as const) Exports.register(name, blips[name]);

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function safe(task: Promise<unknown>, label: string): void { task.catch((error) => logger.warn(`${label}: ${messageOf(error)}`)); }
function refreshAll(): void {
    safe(Promise.all([blips.markers.sync(), blips.players.refresh()]), "Could not refresh blip audiences");
}

Events.emitAllClients("hmp-blips:clear", "{}");
Events.emitAllClients("hmp-blips:players", JSON.stringify({ all: config.showAllPlayers, visible: [], colors: {}, houseTint: config.houseTint, scale: config.playerBlipScale, hideBaseIcon: config.hideBaseIcon }));
Events.onClient("hmp-blips:ready", (player: HmpBlipPlayer) => safe(blips.syncPlayer(player), `Could not sync blips to #${player.id}`));
Events.onClient("hmp-blips:waypoint", (player: HmpBlipPlayer, payload: unknown) => safe(blips.reportWaypoint(player, payload), `Could not take #${player.id}'s waypoint`));
Events.on("playerConnect", (player: HmpBlipPlayer) => {
    safe(blips.syncPlayer(player), `Could not sync blips to #${player.id}`);
    safe(blips.players.refresh(), "Could not refresh player blips after connect");
});
Events.on("playerDisconnect", (player: HmpBlipPlayer) => {
    blips.markers.remove(`test-marker-${player.id}`, "hmp-blips");
    blips.markers.remove(`test-circle-${player.id}`, "hmp-blips");
    blips.disconnect(player);
    safe(blips.players.refresh(), "Could not refresh player blips after disconnect");
});
Events.on("playerLocationChanged", (player: HmpBlipPlayer) => {
    safe(blips.markers.sync(player), `Could not refresh marker context for #${player.id}`);
    safe(blips.players.refresh(), "Could not refresh area-aware player blips");
});
Events.on("hmp:groups:changed", () => refreshAll());
Events.on("hmp:jobs:duty", () => refreshAll());
Events.on("resourceStop", (name?: string) => {
    if (!name || name === "hmp-blips") blips.stop();
    else safe(blips.cleanup(name), `Could not clean up blips owned by '${name}'`);
});

if (config.enableCommands) {
    const commands = Hmp.command.createRouter({ prefix: "[blips]", logger });
    commands.register(config.command, {
        usage: `/${config.command} <status|list|marker [ttl]|circle [radius] [ttl]|pulse|remove|waypoint>`,
        description: "Inspect and privately test Foundations markers.",
    }, async ({ player, args, reply, usage }) => {
        const action = String(args.shift() || "status").toLowerCase();
        if (action === "status") {
            const status = blips.status();
            reply(`${status.markers} marker(s), ${status.playerGroups} player group(s), ${status.expiringMarkers} expiring; show-all=${status.showAllPlayers}`);
            return;
        }
        if (action === "list") {
            const rows = blips.markers.list().slice(0, 30);
            reply(rows.map((row) => `${row.resource}:${row.id}(${row.kind})`).join(", ") || "No live markers.");
            return;
        }
        const current = typeof player.location === "function" ? player.location() : null;
        if (action === "marker" || action === "circle") {
            const circle = action === "circle";
            const radius = circle ? Number(args[0] ?? 80) : undefined;
            const ttl = Number(args[circle ? 1 : 0] ?? 120);
            const result = await blips.markers.upsert({
                resource: "hmp-blips",
                id: `test-${action}-${player.id}`,
                kind: action,
                position: player.position,
                radius,
                label: "Foundations test",
                icon: circle ? "" : "UI_T_MiniMap_Waypoint",
                ttl,
                audience: [player],
                areaId: current?.areaId,
                regionId: current?.regionId,
                virtualWorld: Number(player.virtualWorld || 0),
            });
            reply(`Showing private ${action} '${result.id}' for ${result.ttl}s.`);
            return;
        }
        if (action === "pulse") {
            reply(blips.markers.pulse(`test-circle-${player.id}`, "hmp-blips") ? "Pulsed your test circle." : "Create a test circle first.");
            return;
        }
        if (action === "remove") {
            const removed = Number(blips.markers.remove(`test-marker-${player.id}`, "hmp-blips")) + Number(blips.markers.remove(`test-circle-${player.id}`, "hmp-blips"));
            reply(`Removed ${removed} test marker(s).`);
            return;
        }
        if (action === "waypoint") {
            const waypoint = blips.waypoints.get(player);
            reply(waypoint
                ? `Your waypoint: ${Math.round(waypoint.x)}, ${Math.round(waypoint.y)}, ${Math.round(waypoint.z)}${waypoint.target ? ` on ${waypoint.target}` : ""}${waypoint.areaId ? ` in ${waypoint.areaId}` : ""}.`
                : "No waypoint reported. Place one on the map (it needs a host with Blips.waypoint).");
            return;
        }
        reply(usage);
    });
    Events.on("chatCommand", commands.handle);
}

logger.info(`Blip registry ready; show-all players=${config.showAllPlayers}`);
