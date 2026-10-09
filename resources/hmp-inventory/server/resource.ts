const CONTAINER_KEY = /^[a-z0-9][a-z0-9:_.-]{0,190}$/;
import errorsModule = require("./errors");
import type { HmpInventoryStatus, HmpInventoryView, HmpItemDefinition, HmpNativeItemOptions } from "../types";
import type { CharacterPayload, InventoryResourceOptions, Player } from "./internal";

const { messageOf } = errorsModule;

function createInventoryResource(options: InventoryResourceOptions) {
    const { database, repository, registry, inventory, transfers, native, core, events, config, migrations, logger, listPlayers } = options;
    const clients = new Set();
    const open = new Set();
    let state: HmpInventoryStatus["state"] = "starting";
    let lastError = "";
    let startedAt = Date.now();

    const startPromise = Promise.resolve().then(async () => {
        if (typeof database.ready === "function" && !await database.ready()) throw new Error("hmp-mysql is not ready");
        return database.migrate("hmp-inventory", migrations);
    })
        .then(() => { state = "ready"; return true; })
        .catch((error: unknown) => {
            state = "degraded";
            lastError = messageOf(error);
            throw error;
        });

    function activeResourceName(input: unknown): string {
        const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
        return String(value.resource || value.resourceName || "unknown").trim().slice(0, 64) || "unknown";
    }

    const items = Object.freeze({
        register(definition: HmpItemDefinition<Player>) { return registry.register({ ...definition, resource: activeResourceName(definition) }); },
        unregister: (name: string, resource?: string) => registry.unregister(name, resource),
        get: (name: string) => registry.get(name),
        fromNative: (itemId: string) => registry.fromNative(itemId),
        list: () => registry.list(),
    });

    const containers = Object.freeze({
        async create(spec: { key: string; label?: string; slots?: number; maxWeight?: number; metadata?: Record<string, unknown> }) {
            await startPromise;
            if (!spec || typeof spec !== "object") throw new TypeError("container definition is required");
            const key = String(spec.key || "").toLowerCase();
            if (!CONTAINER_KEY.test(key) || key.startsWith("character:")) throw new TypeError("container key is invalid or reserved");
            return repository.createNamedContainer({
                key,
                label: String(spec.label || key).trim().slice(0, 80),
                slots: Math.max(1, Math.min(500, Math.trunc(Number(spec.slots)) || config.slots)),
                maxWeight: Math.max(0, Math.min(1000000, Number(spec.maxWeight) || config.maxWeight)),
                metadata: spec.metadata && typeof spec.metadata === "object" ? spec.metadata : {},
            });
        },
        async get(key: string) { await startPromise; return repository.getContainer(String(key || "").toLowerCase()); },
        async remove(key: string) { await startPromise; return repository.deleteContainer(String(key || "").toLowerCase()); },
    });

    const transferApi = Object.freeze({
        async move(request: Parameters<typeof transfers.move>[0]) {
            await startPromise;
            return transfers.move(request);
        },
    });

    async function model(player: Player): Promise<HmpInventoryView & { title: string }> {
        await startPromise;
        const data = await inventory.api.get(player);
        return {
            title: core.characters.active(player)?.name || "Inventory",
            ...data,
        };
    }

    async function push(player: Player): Promise<boolean> {
        if (!player || !clients.has(player.id)) return false;
        player.emit("hmp-inventory:model", JSON.stringify(await model(player)));
        return true;
    }

    const ui = Object.freeze({
        async open(player: Player) {
            const payload = await model(player);
            open.add(player.id);
            player.emit("hmp-inventory:open", JSON.stringify(payload));
            return payload;
        },
        close(player: Player): boolean {
            if (!player) return false;
            open.delete(player.id);
            player.emit("hmp-inventory:close", "{}");
            return true;
        },
        refresh: push,
        isOpen: (player: Player) => Boolean(player && open.has(player.id)),
    });

    async function onCharacterLoading(payload: CharacterPayload): Promise<void> {
        await startPromise;
        await inventory.ensureCharacter(payload.character);
        await native.attach(payload.session.player, payload.character);
    }

    async function onCharacterUnloading(payload: CharacterPayload): Promise<void> {
        await native.save(payload.session.player, payload.character);
        open.delete(payload.session.player.id);
        payload.session.player.emit("hmp-inventory:close", "{}");
        native.detach(payload.session.player);
    }

    function disconnect(player?: Player | null): void {
        clients.delete(player?.id);
        open.delete(player?.id);
        native.detach(player);
    }

    function configureClient(player: Player): void {
        player.emit("hmp-inventory:configure", JSON.stringify({
            contract: "hmp.inventory.ui/v1",
            url: config.ui.url,
        }));
    }

    async function saveAll(): Promise<void> {
        const players = listPlayers();
        await Promise.allSettled(players.map((player) => native.save(player, core.characters.active(player))));
        await native.flush();
    }

    async function stop(): Promise<void> {
        await saveAll();
        state = "stopped";
    }

    const status = (): HmpInventoryStatus => ({
        state,
        lastError,
        itemDefinitions: registry.list().length,
        openInventories: open.size,
        readyClients: clients.size,
        native: native.status(),
        uptimeMs: Date.now() - startedAt,
    });

    return Object.freeze({
        items,
        inventory: inventory.api,
        containers,
        transfers: transferApi,
        native: Object.freeze({
            list: native.list,
            save: native.save,
            give: async (player: Player, item: string | HmpItemDefinition<Player>, amount: number, opts?: HmpNativeItemOptions) => native.give(player, typeof item === "string" ? registry.get(item) : item, amount, opts),
            remove: async (player: Player, item: string | HmpItemDefinition<Player>, amount: number, opts?: HmpNativeItemOptions) => native.remove(player, typeof item === "string" ? registry.get(item) : item, amount, opts),
            use: async (player: Player, item: string | HmpItemDefinition<Player>, opts?: Pick<HmpNativeItemOptions, "variation">) => native.use(player, typeof item === "string" ? registry.get(item) : item, opts),
        }),
        ui,
        status,
        ready: () => startPromise,
        onClientReady(player: Player) {
            clients.add(player.id);
            configureClient(player);
            return open.has(player.id) ? push(player) : Promise.resolve(true);
        },
        onCharacterLoading,
        onCharacterUnloading,
        onNativeUpdated: native.onUpdated,
        disconnect,
        removeForResource: (resource: string) => registry.removeForResource(resource),
        saveAll,
        stop,
    });
}

export = { createInventoryResource };
// TypeScript source.
