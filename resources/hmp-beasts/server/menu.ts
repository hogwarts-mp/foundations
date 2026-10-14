import type { HmpUiContextOption, HmpUiServer } from "../../hmp-ui/types";
import type { HmpBeastBagApi, HmpBeastMenuApi, HmpBeastPlayer, HmpStoredBeast } from "../types";
import type { BeastsConfig } from "./internal";

/** hmp-ui shows 32 options at most; a page leaves room for the paging entries. */
const PAGE_SIZE = 30;
const OFFSPRING = "Offspring";

type Ui<P> = Pick<HmpUiServer<P>, "context" | "alert" | "input" | "notify">;

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const words = (id: string): string => id.replace(/([a-z0-9])([A-Z])/g, "$1 $2");

function speciesLabel(species: string): string {
    return species.endsWith(OFFSPRING) && species.length > OFFSPRING.length
        ? `Young ${words(species.slice(0, -OFFSPRING.length))}`
        : words(species);
}

function colorLabel(color: string): string {
    if (!color) return "Coat not rolled yet";
    if (color === "Default") return "Standard coat";
    const variant = /^(Unique)?Variation(\d+)$/.exec(color);
    if (variant) return `${variant[1] ? "Rare variant" : "Variant"} ${variant[2]}`;
    return words(color);
}

function beastTitle(beast: HmpStoredBeast): string {
    return beast.name || speciesLabel(beast.species);
}

function beastSummary(beast: HmpStoredBeast): string {
    const parts = [beast.gender === "female" ? "Female" : "Male", colorLabel(beast.color)];
    return (beast.name ? [speciesLabel(beast.species), ...parts] : parts).join(" · ");
}

function caughtOn(beast: HmpStoredBeast): string {
    return beast.caughtAt > 0 ? new Date(beast.caughtAt).toISOString().slice(0, 10) : "—";
}

function createBeastMenu<P extends HmpBeastPlayer>(deps: {
    bag: Pick<HmpBeastBagApi<P>, "list" | "release" | "rename">;
    ui: Ui<P>;
    config: BeastsConfig;
}): HmpBeastMenuApi<P> {
    const { bag, ui, config } = deps;
    const open = new Set<number>();
    const context = (player: P, reason: string) => ({ resource: "hmp-beasts", actor: player, reason });
    const fail = (player: P, error: unknown) => { ui.notify(player, { title: "Beasts", description: messageOf(error), tone: "error" }); };

    async function pickBeast(player: P, beasts: HmpStoredBeast[], page: number): Promise<string | null> {
        const pages = Math.max(1, Math.ceil(beasts.length / PAGE_SIZE));
        const shown = beasts.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        const options: HmpUiContextOption[] = shown.map((beast) => ({
            id: `beast:${beast.uid}`,
            title: beastTitle(beast),
            description: beastSummary(beast),
            metadata: [{ label: "Caught", value: caughtOn(beast) }],
        }));
        if (page > 0) options.push({ id: "page:previous", title: "Previous page" });
        if (page + 1 < pages) options.push({ id: "page:next", title: "Next page" });
        if (!options.length) {
            options.push({ id: "empty", title: "Your Nab-Sack is empty", description: "Tame beasts you catch with the Nab-Sack are kept here.", disabled: true });
        }
        return ui.context(player, {
            title: "Your beasts",
            description: beasts.length
                ? `${beasts.length} beast${beasts.length === 1 ? "" : "s"} in your Nab-Sack${pages > 1 ? `, page ${page + 1} of ${pages}` : ""}. Pick one to free or rename it.`
                : undefined,
            options,
            cancelLabel: "Close",
        });
    }

    async function free(player: P, beast: HmpStoredBeast): Promise<void> {
        const answer = await ui.alert(player, {
            title: `Free ${beastTitle(beast)}?`,
            content: config.release.respawn
                ? "It leaves your Nab-Sack and goes free in front of you."
                : "It leaves your Nab-Sack for good.",
            confirmLabel: "Free",
            cancelLabel: "Keep",
        });
        if (answer !== "confirm") return;
        try {
            const result = await bag.release(player, beast.uid, context(player, "freed from the beast menu"));
            if (!result) return;
            ui.notify(player, { title: "Beasts", description: `${beastTitle(beast)} is free.`, tone: "success" });
        } catch (error) { fail(player, error); }
    }

    async function rename(player: P, beast: HmpStoredBeast): Promise<void> {
        const result = await ui.input(player, {
            title: `Rename ${beastTitle(beast)}`,
            fields: [{
                name: "name",
                label: "Name",
                type: "text",
                default: beast.name,
                placeholder: speciesLabel(beast.species),
                description: "Leave it empty to go back to the species' own name.",
            }],
            submitLabel: "Rename",
        });
        if (!result) return;
        try {
            const renamed = await bag.rename(player, beast.uid, String(result.name ?? ""), context(player, "renamed from the beast menu"));
            if (renamed) ui.notify(player, { title: "Beasts", description: `Renamed to ${beastTitle(renamed)}.`, tone: "success" });
        } catch (error) { fail(player, error); }
    }

    /** One beast's actions; false when the player closed the menu rather than going back. */
    async function act(player: P, beast: HmpStoredBeast): Promise<boolean> {
        const action = await ui.context(player, {
            title: beastTitle(beast),
            description: `${beastSummary(beast)}. Caught ${caughtOn(beast)}.`,
            options: [
                {
                    id: "free",
                    title: config.release.respawn ? "Free here" : "Free",
                    description: config.release.respawn ? "Let it go in front of you." : "Let it go for good.",
                    tone: "warning",
                },
                { id: "rename", title: "Rename", description: beast.name ? `Now "${beast.name}".` : "Give it a name of your own." },
                { id: "back", title: "Back", description: "Return to your beasts." },
            ],
            cancelLabel: "Close",
        });
        if (action === "free") await free(player, beast);
        else if (action === "rename") await rename(player, beast);
        return action !== null;
    }

    return Object.freeze({
        async open(player: P) {
            if (open.has(player.id)) return;
            open.add(player.id);
            try {
                let page = 0;
                for (;;) {
                    let beasts: HmpStoredBeast[];
                    try { beasts = await bag.list(player); }
                    catch (error) { fail(player, error); return; }
                    beasts.sort((a, b) => speciesLabel(a.species).localeCompare(speciesLabel(b.species)) || a.caughtAt - b.caughtAt);
                    page = Math.min(page, Math.max(0, Math.ceil(beasts.length / PAGE_SIZE) - 1));
                    const choice = await pickBeast(player, beasts, page);
                    if (!choice) return;
                    if (choice === "page:next") { page++; continue; }
                    if (choice === "page:previous") { page = Math.max(0, page - 1); continue; }
                    const beast = beasts.find((entry) => `beast:${entry.uid}` === choice);
                    if (beast && !await act(player, beast)) return;
                }
            } finally {
                open.delete(player.id);
            }
        },
    });
}

export = { createBeastMenu, speciesLabel, colorLabel };
