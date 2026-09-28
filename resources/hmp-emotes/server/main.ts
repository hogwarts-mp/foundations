import configModule = require("./config");
import repositoryModule = require("./repository");
import schemaModule = require("./schema");
import serviceModule = require("./service");
import type { HmpCore, HmpCoreSession } from "../../hmp-core/types";
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpMySQL } from "../../hmp-mysql/types";
import type { HmpEmotePlayer } from "../types";

const { loadConfig } = configModule;
const { createRepository } = repositoryModule;
const { migrations } = schemaModule;
const { createEmoteService } = serviceModule;
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const parse = (raw: unknown): Record<string, unknown> => {
    if (typeof raw === "string") { try { return JSON.parse(raw) as Record<string, unknown>; } catch (_) { return {}; } }
    return raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
};

const Hmp = Imports.get<HmpLibServer<HmpEmotePlayer>>("hmp-lib");
const database = Imports.get<HmpMySQL>("hmp-mysql");
const core = Imports.get<HmpCore<HmpEmotePlayer>>("hmp-core");
const logger = Hmp.logger.create("hmp-emotes");
const config = loadConfig(Hmp);
const repository = createRepository(database);
const service = createEmoteService({ database, repository, core, config, migrations, players: () => PlayerManager.getAll(), events: Events });
const actions = Hmp.rateLimit.create<number>({ limit: 10, windowMs: 2000 });

for (const name of ["emotes", "aliases", "favorites", "ui", "status"] as const) Exports.register(name, service[name]);

function run(player: HmpEmotePlayer, work: () => Promise<unknown> | unknown): void {
    Promise.resolve().then(work).catch((error) => {
        logger.warn(`Request from #${player.id} failed: ${messageOf(error)}`);
        player.sendChat?.(`[emotes] ${messageOf(error)}`);
    });
}

Events.onClient("hmp-emotes:ready", (player) => run(player, () => service.onClientReady(player)));
Events.onClient("hmp-emotes:aliases-request", (player) => run(player, () => service.aliasRequest(player)));
Events.onClient("hmp-emotes:favorites-request", (player) => run(player, () => service.favoriteRequest(player)));
Events.onClient("hmp-emotes:favorite-toggle", (player, raw) => {
    if (!actions.allow(player.id)) return;
    const payload = parse(raw);
    run(player, () => service.favorites.toggle(player, String(payload.path || "")));
});
Events.onClient("hmp-emotes:allow-toggle", (player, raw) => {
    if (!actions.allow(player.id)) return;
    const payload = parse(raw);
    run(player, async () => {
        const path = String(payload.path || "");
        if (payload.allowed === true) {
            const entry = await service.aliases.allow(player, {
                path,
                kind: payload.kind === "ability" ? "ability" : "pose",
                channel: payload.channel === "PartialBody" ? "PartialBody" : "FullBody",
            });
            player.sendChat?.(`[emotes] allowed '${entry.name}'`);
        } else {
            const removed = await service.aliases.deny(player, path);
            player.sendChat?.(`[emotes] removed ${removed} server alias${removed === 1 ? "" : "es"}`);
        }
    });
});
Events.onClient("hmp-emotes:alias-set", (player, raw) => {
    if (!actions.allow(player.id)) return;
    const payload = parse(raw);
    run(player, async () => {
        const alias = String(payload.alias || "").trim().toLowerCase();
        if (!alias) {
            const removed = await service.aliases.clearPath(player, String(payload.path || ""));
            player.sendChat?.(`[emotes] cleared ${removed} alias${removed === 1 ? "" : "es"}`);
            return;
        }
        await service.aliases.set(player, {
            name: alias,
            path: String(payload.path || ""),
            kind: payload.kind === "ability" ? "ability" : "pose",
            channel: payload.channel === "PartialBody" ? "PartialBody" : "FullBody",
        });
        player.sendChat?.(`[emotes] alias '${alias}' saved`);
    });
});
Events.onClient("hmp-emotes:menu-closed", (player) => service.ui.close(player));
Events.onClient("hmp-emotes:result", (player, raw) => {
    const text = String(parse(raw).text || "").trim().slice(0, 500);
    if (text) player.sendChat?.(`[emotes] ${text}`);
});

Events.on("hmp:session:ready", (raw: unknown) => {
    const session = raw as HmpCoreSession<HmpEmotePlayer>;
    if (session?.player) run(session.player, () => service.ui.sync(session.player));
});
Events.on("hmp:groups:changed", () => {
    for (const player of PlayerManager.getAll()) run(player, () => service.aliasRequest(player));
});
Events.on("hmp:session:ended", (raw: unknown) => {
    const session = raw as HmpCoreSession<HmpEmotePlayer>;
    if (session?.player) service.disconnect(session.player);
});
Events.on("resourceStop", (name?: string) => {
    if (!name || name === "hmp-emotes") service.stop();
    else service.removeForResource(name);
});

const router = Hmp.command.createRouter({ logger });
router.register(config.command, {
    aliases: ["e", "emotes", "emotemenu"],
    description: "Play, browse, or stop a server-curated emote.",
    usage: `/${config.command} <name|menu|stop|list>`,
}, async (context) => {
    const invoked = context.invokedAs.toLowerCase();
    let action = String(context.args[0] || "list").toLowerCase();
    if (invoked === "emotemenu") action = "menu";
    else if (invoked === "emotes" && !context.args.length) action = "list";
    if (action === "menu" || action === "m") { await service.ui.open(context.player); return; }
    if (["stop", "cancel", "s", "c"].includes(action)) { service.emotes.stop(context.player); context.reply("[emotes] stopped"); return; }
    if (action === "list") {
        const names = service.emotes.list().map((entry) => entry.name);
        context.reply(names.length ? `[emotes] ${names.length} emotes: ${names.join(", ")}` : "[emotes] no emotes are configured");
        context.reply(`[emotes] play with /${invoked === "e" ? "e" : config.command} <name>, browse with /${config.command} menu, stop with /${config.command} stop`);
        return;
    }
    if (!await service.emotes.play(context.player, action)) context.reply(`[emotes] no emote named '${action}'`);
});

const editorGuard = async ({ player }: { player: HmpEmotePlayer }) => {
    const groups = config.editorGroups;
    return (await Promise.all(groups.map((group) => core.groups.has(player, group.key, group.minimumGrade || 0)))).some(Boolean)
        || "You do not have permission to use emote diagnostics.";
};
router.register("playability", { usage: "/playability <classPath> [FullBody|PartialBody]", guard: editorGuard }, (context) => {
    context.player.emit("hmp-emotes:play-ability", JSON.stringify({ path: context.args[0] || "", channel: context.args[1] || "FullBody" }));
});
Events.on("chatCommand", (player: HmpEmotePlayer, message: string, command: string, args: string[]) => {
    void router.handle(player, message, command, args);
});

Events.on("resourceStart", async (name?: string) => {
    if (name && name !== "hmp-emotes") return;
    await service.ready();
    logger.info(`Emotes ready with ${service.status().aliases} alias(es)`);
});
