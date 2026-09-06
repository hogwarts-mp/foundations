import configModule = require("./config");
import discordModule = require("./providers/discord");
import routesModule = require("./routes");
import serviceModule = require("./service");
import type { HmpLibServer } from "../../hmp-lib/types";

const { loadConfig } = configModule;
const { createDiscordProvider } = discordModule;
const { registerRoutes } = routesModule;
const { createWebhookService } = serviceModule;
const Hmp = Imports.get<HmpLibServer>("hmp-lib");
const logger = Hmp.logger.create("hmp-webhooks");
const config = loadConfig(Hmp);
const webhooks = createWebhookService({ config, logger, providers: [createDiscordProvider()] });

Exports.register("send", webhooks.send);
Exports.register("status", webhooks.status);

registerRoutes({ events: Events, routes: config.routes, send: webhooks.send });
Events.on("resourceStop", (name?: unknown) => {
    if (!name || name === "hmp-webhooks") webhooks.stop();
});

const configured = webhooks.status().destinations.filter((destination) => destination.enabled && destination.configured).length;
logger.info(`Outbound webhooks ready: enabled=${config.enabled}, configured destinations=${configured}`);
// TypeScript source.
