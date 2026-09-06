import type { HmpItemDefinition } from "../types";
import type { Player } from "./internal";

interface CuratedNativeItem {
    name: string;
    aliases?: string[];
    label: string;
    itemId: string;
    itemType: string;
    holder: string;
    maxStack: number;
    icon: string;
}

const curated: CuratedNativeItem[] = [
    ["focus_potion", "Focus Potion", "AMFillPotion", "PotionUsable", "SanctuaryWheel", 12, "potion.svg"],
    ["thunderbrew", "Thunderbrew", "AutoDamagePotion", "PotionUsable", "SanctuaryWheel", 12, "potion.svg"],
    ["edurus_potion", "Edurus Potion", "Edurus", "PotionUsable", "SanctuaryWheel", 12, "potion.svg"],
    ["felix_felicis", "Felix Felicis", "FelixFelicis", "PotionUsable", "SanctuaryWheel", 12, "potion.svg"],
    ["invisibility_potion", "Invisibility Potion", "InvisibilityPotion", "PotionUsable", "SanctuaryWheel", 12, "potion.svg"],
    ["maxima_potion", "Maxima Potion", "Maxima", "PotionUsable", "SanctuaryWheel", 12, "potion.svg"],
    ["wiggenweld_potion", "Wiggenweld Potion", "WoundCleaning", "PotionUsable", "HealthPotionStorage", 25, "potion.svg"],
    ["chomping_cabbage", "Chinese Chomping Cabbage", "ChompingCabbage_Byproduct", "PlantUsable", "SanctuaryWheel", 12, "plant.svg"],
    ["mandrake", "Mandrake", "Mandrake_Byproduct", "PlantUsable", "SanctuaryWheel", 12, "plant.svg"],
    ["venomous_tentacula", "Venomous Tentacula", "VenomousTentacula_Byproduct", "PlantUsable", "SanctuaryWheel", 12, "plant.svg"],
    ["ashwinder_eggs", "Ashwinder Eggs", "AshwinderEggs", "Forageable", "ResourceInventory", 999, "ingredient.svg"],
    ["horklump_juice", "Horklump Juice", "HorklumpJuice", "Forageable", "ResourceInventory", 999, "ingredient.svg"],
    ["lacewing_flies", "Lacewing Flies", "LacewingFlies", "Forageable", "ResourceInventory", 999, "ingredient.svg"],
    ["leech_juice", "Leech Juice", "LeechJuice", "Forageable", "ResourceInventory", 999, "ingredient.svg"],
    ["moonstone", "Moonstone", "Moonstone", "Resource", "ResourceInventory", 999, "ingredient.svg"],
    ["fertiliser", "Fertiliser", "Fertiliser", "SanctuaryItem", "ResourceInventory", 999, "ingredient.svg"],
    ["galleons", "Galleons", "Knuts", "SPECIAL", "ResourceInventory", 999999, "coin.svg", ["native:knuts"]],
].map(([name, label, itemId, itemType, holder, maxStack, icon, aliases]) => ({ name, label, itemId, itemType, holder, maxStack, icon, aliases })) as CuratedNativeItem[];

const curatedById = new Map(curated.map((item) => [item.itemId, item]));
const iconUrl = (file: string) => `fw://resources/hmp-inventory/dist/icons/${file}`;

function prettify(value: string): string {
    return value
        .replace(/[_-]+/g, " ")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replace(/\s+/g, " ")
        .trim();
}

function defaultIcon(definition: HogwartsMpInventoryCatalogDefinition): string {
    const type = definition.itemType.toLowerCase();
    if (type.includes("potion")) return "potion.svg";
    if (type.includes("plant")) return "plant.svg";
    if (type.includes("forage") || type.includes("resource") || type.includes("ingredient")) return "ingredient.svg";
    if (["gear", "tool", "mount"].includes(definition.kind)) return `${definition.kind}.svg`;
    return "item.svg";
}

function fallbackDefinitions(): HogwartsMpInventoryCatalogDefinition[] {
    return curated.map((item) => ({
        itemId: item.itemId,
        itemType: item.itemType,
        holder: item.holder,
        maxStack: item.maxStack,
        kind: "item",
        inventoryable: true,
        persistent: true,
        consumable: item.itemType === "PotionUsable" || item.itemType === "PlantUsable",
        usableFromInventory: false,
    }));
}

function createNativeItems(catalog?: HogwartsMpInventoryCatalog | null): HmpItemDefinition<Player>[] {
    if (catalog) {
        const info = catalog.info();
        if (info.schemaVersion !== 1) throw new Error(`Unsupported InventoryCatalog schema version '${String(info.schemaVersion)}'`);
    }
    const definitions = catalog ? catalog.list({ inventoryable: true }) : fallbackDefinitions();
    return definitions.map((definition) => {
        const override = curatedById.get(definition.itemId);
        return {
            name: `native:${override?.name || definition.itemId.toLowerCase()}`,
            aliases: override?.aliases,
            label: override?.label || prettify(definition.itemId) || definition.itemId,
            nativeId: definition.itemId,
            category: prettify(definition.itemType) || "Native",
            holder: definition.holder,
            maxStack: Math.max(1, definition.maxStack),
            icon: iconUrl(override?.icon || defaultIcon(definition)),
            weight: 0,
            kind: definition.kind,
            unique: definition.kind === "gear",
            usable: definition.usableFromInventory,
            consumable: definition.consumable,
            referenceValue: Number.isFinite(definition.economyValue) && Number(definition.economyValue) > 0 ? Math.trunc(Number(definition.economyValue)) : undefined,
            resource: "hmp-inventory",
        };
    });
}

export = { createNativeItems };
