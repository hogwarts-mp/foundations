const ITEM_NAME = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
import type { NormalizedItemDefinition, Player, Registry } from "./internal";
import type { HmpInventoryUseContext } from "../types";

function clean(value: unknown, length: number): string {
    return String(value ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, length);
}

function prettify(value: unknown): string {
    return String(value || "")
        .replace(/[_-]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replace(/\s+/g, " ")
        .trim();
}

function createItemRegistry(): Registry {
    const definitions = new Map<string, NormalizedItemDefinition>();
    const nativeIds = new Map<string, string>();
    const aliases = new Map<string, string>();

    function normalize(raw: unknown): NormalizedItemDefinition {
        if (!raw || typeof raw !== "object") throw new TypeError("item definition is required");
        const value = raw as Record<string, unknown>;
        const name = clean(value.name, 64).toLowerCase();
        if (!ITEM_NAME.test(name)) throw new TypeError("item name must match [a-z0-9:_-] and contain at most 64 characters");
        const itemAliases = [...new Set((Array.isArray(value.aliases) ? value.aliases : []).map((entry) => clean(entry, 64).toLowerCase()).filter((entry) => entry !== name))].slice(0, 16);
        if (itemAliases.some((entry) => !ITEM_NAME.test(entry))) throw new TypeError("item aliases must match [a-z0-9:_-] and contain at most 64 characters");
        const nativeId = clean(value.nativeId, 96) || null;
        const unique = value.unique === true;
        const maxStack = unique ? 1 : Math.max(1, Math.min(100000, Math.trunc(Number(value.maxStack ?? value.stack)) || 1));
        const weight = Math.max(0, Math.min(100000, Number(value.weight) || 0));
        const referenceValue = Math.trunc(Number(value.referenceValue));
        return Object.freeze({
            name,
            aliases: Object.freeze(itemAliases),
            label: clean(value.label ?? value.displayName ?? prettify(name), 80) || name,
            description: clean(value.description, 240),
            icon: clean(value.icon, 512),
            category: clean(value.category ?? value.itemType ?? "Miscellaneous", 48) || "Miscellaneous",
            kind: ["item", "gear", "tool", "mount"].includes(String(value.kind)) ? value.kind as NormalizedItemDefinition["kind"] : "item",
            weight,
            maxStack,
            unique,
            usable: value.usable === true || typeof value.use === "function",
            consumable: value.consumable === true,
            use: typeof value.use === "function" ? value.use as (context: HmpInventoryUseContext<Player>) => void | Promise<void> : null,
            referenceValue: Number.isFinite(referenceValue) && referenceValue > 0 ? Math.min(2147483647, referenceValue) : undefined,
            nativeId,
            holder: nativeId ? clean(value.holder, 64) || null : null,
            resource: clean(value.resource ?? "unknown", 64) || "unknown",
            native: Boolean(nativeId),
        }) as unknown as NormalizedItemDefinition;
    }

    function register(raw: unknown): NormalizedItemDefinition {
        const definition = normalize(raw);
        const current = definitions.get(definition.name);
        if (current && current.resource !== definition.resource) throw new Error(`item '${definition.name}' is already owned by ${current.resource}`);
        const canonicalCollision = aliases.get(definition.name);
        if (canonicalCollision && canonicalCollision !== definition.name) throw new Error(`item '${definition.name}' is already an alias for ${canonicalCollision}`);
        if (definition.nativeId) {
            const mapped = nativeIds.get(definition.nativeId.toLowerCase());
            if (mapped && mapped !== definition.name) throw new Error(`native item '${definition.nativeId}' is already mapped to ${mapped}`);
        }
        for (const alias of definition.aliases) {
            const mapped = aliases.get(alias);
            if (definitions.has(alias) && alias !== definition.name) throw new Error(`item alias '${alias}' is already a canonical item`);
            if (mapped && mapped !== definition.name) throw new Error(`item alias '${alias}' is already mapped to ${mapped}`);
        }
        if (current?.nativeId) nativeIds.delete(current.nativeId.toLowerCase());
        for (const alias of current?.aliases || []) aliases.delete(alias);
        definitions.set(definition.name, definition);
        if (definition.nativeId) nativeIds.set(definition.nativeId.toLowerCase(), definition.name);
        for (const alias of definition.aliases) aliases.set(alias, definition.name);
        return definition;
    }

    function unregister(name: string, resource?: string): boolean {
        const requested = String(name || "").toLowerCase();
        const key = definitions.has(requested) ? requested : aliases.get(requested) || requested;
        const current = definitions.get(key);
        if (!current || (resource && current.resource !== resource)) return false;
        definitions.delete(key);
        if (current.nativeId) nativeIds.delete(current.nativeId.toLowerCase());
        for (const alias of current.aliases) aliases.delete(alias);
        return true;
    }

    function get(name: string): NormalizedItemDefinition | null {
        const requested = String(name || "").toLowerCase();
        return definitions.get(requested)
            || definitions.get(aliases.get(requested) || "")
            || definitions.get(nativeIds.get(requested) || "")
            || null;
    }

    function fromNative(itemId: string): NormalizedItemDefinition | null {
        const mapped = nativeIds.get(String(itemId || "").toLowerCase());
        return mapped ? definitions.get(mapped) || null : null;
    }

    function removeForResource(resource: string): number {
        let removed = 0;
        for (const definition of [...definitions.values()]) if (definition.resource === resource && unregister(definition.name, resource)) removed++;
        return removed;
    }

    return Object.freeze({ register, unregister, get, fromNative, list: () => [...definitions.values()], removeForResource });
}

export = { createItemRegistry, prettify };
// TypeScript source.
