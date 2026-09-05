import normalizeModule = require("../shared/normalize");
import type { HmpLibServer } from "../../hmp-lib/types";
import type { HmpShopDefinition } from "../types";

const { normalizeShop } = normalizeModule;

/** Shops declared in `data/hmp-shops.json`; owned by hmp-shops and registered after the service starts. */
export interface ShopsConfig {
    shops: HmpShopDefinition[];
}

export function normalizeConfig(raw: unknown): ShopsConfig {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("hmp-shops configuration must be an object");
    const value = raw as Record<string, unknown>;
    const entries = value.shops === undefined ? [] : value.shops;
    if (!Array.isArray(entries)) throw new TypeError("hmp-shops configuration 'shops' must be an array");
    const seen = new Set<string>();
    const shops = entries.map((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError(`hmp-shops configuration shops[${index}] must be an object`);
        // Data shops are owned by hmp-shops itself; a JSON file cannot carry handlers or predicates.
        const shop = normalizeShop({ ...(entry as HmpShopDefinition), resource: "hmp-shops" });
        if (seen.has(shop.id)) throw new TypeError(`hmp-shops configuration declares shop '${shop.id}' twice`);
        seen.add(shop.id);
        return shop;
    });
    return { shops };
}

export function loadConfig(Hmp: HmpLibServer, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): ShopsConfig {
    const env = options.env || process.env;
    const loaded = Hmp.config.load<Record<string, unknown>>(env.HMP_SHOPS_CONFIG || "data/hmp-shops.json", {
        cwd: options.cwd || process.cwd(),
        defaults: { shops: [] },
    });
    return normalizeConfig(loaded);
}
