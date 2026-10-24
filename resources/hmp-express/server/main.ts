import configModule = require("./config");
import serviceModule = require("./service");
import type { HmpLibServer } from "../../hmp-lib/types";
import type { ExpressClock } from "./internal";

declare const World: (ExpressClock & { readonly hogwartsExpress?: Partial<HogwartsMpHogwartsExpress> | null }) | undefined;

const { loadConfig } = configModule;
const { createExpressService } = serviceModule;

const Hmp = Imports.get<HmpLibServer>("hmp-lib");
const logger = Hmp.logger.create("hmp-express");
const config = loadConfig(Hmp);
// A host without World.hogwartsExpress degrades at startup instead of failing to load; its clients keep the game's own
// timetable.
const express = typeof World !== "undefined" && World !== null ? World.hogwartsExpress : null;
const native = express && (["spawn", "moveTo", "depart", "halt", "despawn", "get"] as const).every((name) => typeof express[name] === "function")
    ? express as HogwartsMpHogwartsExpress
    : null;
const service = createExpressService({
    config,
    native,
    clock: () => ({ hour: World!.hour, minute: World!.minute, day: World!.day, month: World!.month, year: World!.year, timeScale: World!.timeScale }),
    logger,
});

Exports.register("train", service.train);
Exports.register("status", service.status);

Events.on("trainStopped", () => service.stopped());
Events.on("trainEnded", () => service.ended());
Events.on("resourceStop", (name?: string) => { if (!name || name === "hmp-express") service.stop(); });

const status = service.status();
if (status.state === "disabled") logger.info("Hogwarts Express disabled; the train is left to other scripts.");
else if (!native) logger.error("This server build has no World.hogwartsExpress; the Hogwarts Express is not run.");
else if (status.state === "degraded") logger.error(`The Hogwarts Express route cannot run: ${status.lastError}`);
else logger.info(`Hogwarts Express ready: ${config.departures.length} departure(s), ${config.stops.length ? `stopping at ${config.stops.map((entry) => `${entry.at} (${entry.dwellSeconds} s)`).join(", ")}` : "straight through"}`);
