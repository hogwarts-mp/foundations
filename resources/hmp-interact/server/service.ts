import normalizeModule = require("../shared/normalize");
import type {
    HmpInteractPlayer,
    HmpInteractionContext,
    HmpInteractionDefinition,
    HmpInteractionOption,
    HmpInteractionRequirements,
} from "../types";
import type { InteractDependencies, InteractService } from "./internal";

const { clean, normalizeInteraction, publicZone } = normalizeModule;

interface GateResult {
    ok: boolean;
    reason: string;
}

function distance(left: { x: number; y: number; z: number }, right: { x: number; y: number; z: number }): number {
    return Math.hypot(Number(left.x) - Number(right.x), Number(left.y) - Number(right.y), Number(left.z) - Number(right.z));
}

function worldObjectKey(id: string): string {
    return `hmp-interact:${id}`;
}

/** Centimetres over the pawn origin for a character's nameplate; matches the mod's player nameplates. */
const CHARACTER_LABEL_HEIGHT = 100;

function createInteractService<P extends HmpInteractPlayer>(dependencies: InteractDependencies<P>): InteractService<P> {
    const { core, inventory, ui, events, logger } = dependencies;
    const now = dependencies.now || Date.now;
    const startedAt = now();
    const interactions = new Map<string, HmpInteractionDefinition<P>>();
    const activePlayers = new Set<number>();
    const lockedInteractions = new Set<string>();
    const cooldowns = new Map<string, number>();
    const lastTriggers = new Map<number, number>();
    /** Interaction id -> the player seated on it, until their client reports them standing. */
    const seats = new Map<string, number>();
    /** Players whose snapshots carry each zone's radius, for the closed-test outlines. */
    const outlined = new Set<number>();
    let revision = 0;
    let stopped = false;

    function playerId(player: P): number {
        const id = Number(player?.id);
        if (!Number.isSafeInteger(id) || id < 0 || typeof player?.emit !== "function") throw new TypeError("a connected player is required");
        return id;
    }

    function emit(player: P, eventName: string, payload: unknown): boolean {
        try { player.emit(eventName, JSON.stringify(payload)); return true; }
        catch (_) { return false; }
    }

    function locationContext(player: P): HogwartsMpPlayerLocation | null | undefined {
        if (typeof player.location !== "function") return undefined;
        try { return player.location(); }
        catch (_) { return null; }
    }

    function matchesContext(player: P, definition: HmpInteractionDefinition<P>): boolean {
        const location = locationContext(player);
        if (location === null) return false;
        if (!definition.areaId && !definition.regionId) return true;
        if (!location) return false;
        if (definition.areaId && definition.areaId.toLowerCase() !== location.areaId.toLowerCase()) return false;
        return !definition.regionId || definition.regionId.toLowerCase() === location.regionId.toLowerCase();
    }

    function snapshot(player: P) {
        const virtualWorld = Number(player.virtualWorld || 0);
        const outlines = outlined.has(player.id);
        return {
            revision,
            ...(outlines ? { outlines } : {}),
            interactions: [...interactions.values()]
                .filter((definition) => definition.virtualWorld === undefined || definition.virtualWorld === virtualWorld)
                .filter((definition) => matchesContext(player, definition))
                .map((definition) => outlines ? { ...publicZone(definition), radius: definition.radius } : publicZone(definition)),
        };
    }

    function sync(player: P): boolean {
        playerId(player);
        return emit(player, "hmp-interact:snapshot", snapshot(player));
    }

    function setOutlines(player: P, enabled?: boolean): boolean {
        const owner = playerId(player);
        const next = enabled ?? !outlined.has(owner);
        if (next) outlined.add(owner);
        else outlined.delete(owner);
        sync(player);
        return next;
    }

    function broadcast(): void {
        for (const player of dependencies.players()) emit(player, "hmp-interact:snapshot", snapshot(player));
    }

    function owns(definition: HmpInteractionDefinition<P> | undefined): boolean {
        return Boolean(definition && (definition.object || definition.character));
    }

    function publish(definition: HmpInteractionDefinition<P>): void {
        const object = definition.object;
        if (object && dependencies.worldObjects) {
            const created = dependencies.worldObjects.create(worldObjectKey(definition.id), object.model, {
                ...definition.position,
                pitch: object.pitch,
                yaw: object.yaw,
                roll: object.roll,
                scale: object.scale,
                collision: object.collision,
                streamRange: object.streamRange,
                drawDistance: object.drawDistance,
                animation: object.animation,
                material: object.material,
                startFx: object.startFx,
            });
            // A server that warns-and-returns instead of throwing would otherwise leave a registered zone
            // whose prompt works and whose mesh never appears.
            if (!created) throw new Error(`world object for '${definition.id}' was refused (model: ${String(object.model)})`);
        }
        const character = definition.character;
        if (character && dependencies.characters) {
            // The optional nameplate sits at player-nameplate height, independent of the chest-level prompt.
            const created = dependencies.characters.create(worldObjectKey(definition.id), character.characterId, {
                ...definition.position,
                yaw: character.yaw,
                scale: character.scale,
                label: character.label,
                promptHeight: CHARACTER_LABEL_HEIGHT,
            });
            if (!created) throw new Error(`character for '${definition.id}' was refused (id: ${character.characterId})`);
        }
    }

    function unpublish(definition: HmpInteractionDefinition<P>): void {
        if (definition.object && dependencies.worldObjects) dependencies.worldObjects.destroy(worldObjectKey(definition.id));
        if (definition.character && dependencies.characters) dependencies.characters.destroy(worldObjectKey(definition.id));
    }

    function register(raw: HmpInteractionDefinition<P>): () => boolean {
        if (stopped) throw new Error("hmp-interact is stopped");
        const definition = normalizeInteraction(raw);
        const existing = interactions.get(definition.id);
        if (existing && existing.resource !== definition.resource) {
            throw new Error(`interaction '${definition.id}' is already owned by '${existing.resource}'`);
        }
        if (existing && owns(existing)) unpublish(existing);
        try { publish(definition); }
        catch (error) {
            if (existing && owns(existing)) {
                try { publish(existing); }
                catch (restoreError) { logger.error(`[hmp-interact] could not restore '${existing.id}' after replacement failed`, restoreError); }
            }
            throw error;
        }
        interactions.set(definition.id, definition);
        revision++;
        broadcast();
        let registered = true;
        return () => {
            if (!registered || interactions.get(definition.id) !== definition) return false;
            registered = false;
            return unregister(definition.id, definition.resource);
        };
    }

    function unregister(rawId: string, resource?: string): boolean {
        const id = String(rawId || "").trim();
        const definition = interactions.get(id);
        if (!definition || (resource && definition.resource !== resource)) return false;
        interactions.delete(id);
        if (owns(definition)) unpublish(definition);
        lockedInteractions.delete(id);
        seats.delete(id);
        for (const key of [...cooldowns.keys()]) if (key.includes(`:${id}:`)) cooldowns.delete(key);
        revision++;
        broadcast();
        return true;
    }

    function unregisterResource(resource: string): number {
        let removed = 0;
        for (const definition of [...interactions.values()]) {
            if (definition.resource === resource && unregister(definition.id, resource)) removed++;
        }
        return removed;
    }

    function contextFor(player: P, definition: HmpInteractionDefinition<P>, option: HmpInteractionOption<P> | null): HmpInteractionContext<P> {
        const character = core.characters.active(player) as HmpInteractionContext<P>["character"];
        return { player, character, interaction: definition, option, distance: distance(player.position, definition.position) };
    }

    async function gate(requirements: HmpInteractionRequirements<P> | undefined, context: HmpInteractionContext<P>): Promise<GateResult> {
        if (!requirements) return { ok: true, reason: "" };
        if (requirements.character && !context.character) return { ok: false, reason: "Select a character first." };
        const groups = requirements.groups || [];
        if (groups.length) {
            const results = await Promise.all(groups.map((entry) => core.groups.has(context.player, entry.key, entry.minimumGrade || 0)));
            const allowed = requirements.groupMode === "any" ? results.some(Boolean) : results.every(Boolean);
            if (!allowed) return { ok: false, reason: "You do not have the required group access." };
        }
        for (const item of requirements.items || []) {
            if (!await inventory.inventory.has(context.player, item.name, item.amount || 1, { metadata: item.metadata })) {
                return { ok: false, reason: `You need ${item.amount || 1} ${item.name}.` };
            }
        }
        if (requirements.allow) {
            const result = await requirements.allow(context);
            if (result !== true) return { ok: false, reason: typeof result === "string" ? clean(result, 160) || "That interaction is unavailable." : "That interaction is unavailable." };
        }
        return { ok: true, reason: "" };
    }

    function inRange(player: P, definition: HmpInteractionDefinition<P>): number | null {
        if (!player.position || ![player.position.x, player.position.y, player.position.z].every((value) => Number.isFinite(Number(value)))) return null;
        if (definition.virtualWorld !== undefined && Number(player.virtualWorld || 0) !== definition.virtualWorld) return null;
        if (!matchesContext(player, definition)) return null;
        const measured = distance(player.position, definition.position);
        return measured <= (definition.radius || 250) ? measured : null;
    }

    function cooldownKey(owner: number, definition: HmpInteractionDefinition<P>, option: HmpInteractionOption<P> | null): string {
        return `${owner}:${definition.id}:${option?.id || "default"}`;
    }

    function seatTaken(player: P, definition: HmpInteractionDefinition<P>): boolean {
        const occupant = seats.get(definition.id);
        if (occupant === undefined || occupant === playerId(player)) return false;
        ui.notify(player, { description: "Someone is already sitting there.", tone: "warning" });
        return true;
    }

    function sit(player: P, definition: HmpInteractionDefinition<P>): boolean {
        const seat = definition.seat;
        if (!seat || stopped || interactions.get(definition.id) !== definition || seatTaken(player, definition)) return false;
        const owner = playerId(player);
        for (const [id, occupant] of seats) if (occupant === owner) seats.delete(id);
        seats.set(definition.id, owner);
        if (emit(player, "hmp-interact:seat", { id: definition.id, ...seat })) return true;
        seats.delete(definition.id);
        return false;
    }

    function stand(player: P, rawId: string): boolean {
        const id = String(rawId || "").trim();
        return seats.get(id) === playerId(player) && seats.delete(id);
    }

    async function execute(player: P, definition: HmpInteractionDefinition<P>, option: HmpInteractionOption<P> | null): Promise<boolean> {
        const owner = playerId(player);
        if (stopped || interactions.get(definition.id) !== definition) return false;
        const measured = inRange(player, definition);
        if (measured === null) return false;
        const context = contextFor(player, definition, option);
        context.distance = measured;
        const topGate = await gate(definition.requirements, context);
        if (!topGate.ok) { ui.notify(player, { description: topGate.reason, tone: "warning" }); return false; }
        const optionGate = await gate(option?.requirements, context);
        if (!optionGate.ok) { ui.notify(player, { description: optionGate.reason, tone: "warning" }); return false; }
        const key = cooldownKey(owner, definition, option);
        const remaining = (cooldowns.get(key) || 0) - now();
        if (remaining > 0) {
            ui.notify(player, { description: `Try again in ${Math.max(1, Math.ceil(remaining / 1000))}s.`, tone: "warning" });
            return false;
        }
        if (definition.seat && seatTaken(player, definition)) return false;
        if (definition.exclusive && lockedInteractions.has(definition.id)) {
            ui.notify(player, { description: "Someone else is using that right now.", tone: "warning" });
            return false;
        }
        if (definition.exclusive) lockedInteractions.add(definition.id);
        try {
            const progress = option?.progress || definition.progress;
            if (progress) {
                const completed = await ui.progress(player, {
                    label: progress.label || option?.label || definition.label,
                    duration: progress.duration,
                    canCancel: progress.canCancel,
                    cancelLabel: progress.cancelLabel,
                });
                if (!completed || stopped || interactions.get(definition.id) !== definition || inRange(player, definition) === null) return false;
                const repeatedTopGate = await gate(definition.requirements, contextFor(player, definition, option));
                const repeatedOptionGate = await gate(option?.requirements, contextFor(player, definition, option));
                if (!repeatedTopGate.ok || !repeatedOptionGate.ok) return false;
            }
            const handler = option?.handler || definition.handler;
            if ((!handler && !definition.seat) || stopped || interactions.get(definition.id) !== definition) return false;
            if (handler) await handler(contextFor(player, definition, option));
            if (definition.seat && !sit(player, definition)) return false;
            cooldowns.set(key, now() + (option?.cooldownMs ?? definition.cooldownMs ?? 0));
            events.emit("hmp:interact:used", contextFor(player, definition, option));
            return true;
        } catch (error) {
            logger.error(`[hmp-interact] '${definition.id}' handler failed`, error);
            ui.notify(player, { description: "That interaction could not be completed.", tone: "error" });
            return false;
        } finally {
            if (definition.exclusive) lockedInteractions.delete(definition.id);
        }
    }

    async function trigger(player: P, rawId: string): Promise<boolean> {
        const owner = playerId(player);
        const triggeredAt = now();
        if (triggeredAt - (lastTriggers.get(owner) || 0) < 200) return false;
        lastTriggers.set(owner, triggeredAt);
        const id = String(rawId || "").trim();
        const definition = interactions.get(id);
        if (!definition || activePlayers.has(owner) || inRange(player, definition) === null) return false;
        activePlayers.add(owner);
        try {
            const initial = contextFor(player, definition, null);
            const initialGate = await gate(definition.requirements, initial);
            if (!initialGate.ok) { ui.notify(player, { description: initialGate.reason, tone: "warning" }); return false; }
            if (!definition.options?.length) return execute(player, definition, null);
            const evaluated = await Promise.all(definition.options.map(async (option) => ({ option, gate: await gate(option.requirements, contextFor(player, definition, option)) })));
            const selectedId = await ui.context(player, {
                title: definition.label,
                description: definition.description,
                options: evaluated.map(({ option, gate: result }) => ({
                    id: option.id,
                    title: option.label,
                    description: result.ok ? option.description : result.reason,
                    disabled: !result.ok,
                })),
                canClose: true,
            });
            if (!selectedId) return false;
            const selected = definition.options.find((option) => option.id === selectedId) || null;
            return selected ? execute(player, definition, selected) : false;
        } finally {
            activePlayers.delete(owner);
        }
    }

    function disconnect(player: P): boolean {
        const owner = playerId(player);
        activePlayers.delete(owner);
        lastTriggers.delete(owner);
        for (const key of [...cooldowns.keys()]) if (key.startsWith(`${owner}:`)) cooldowns.delete(key);
        for (const [id, occupant] of seats) if (occupant === owner) seats.delete(id);
        outlined.delete(owner);
        return true;
    }

    function stop(): number {
        if (stopped) return 0;
        stopped = true;
        const count = interactions.size;
        for (const definition of interactions.values()) if (owns(definition)) unpublish(definition);
        interactions.clear();
        activePlayers.clear();
        lockedInteractions.clear();
        cooldowns.clear();
        lastTriggers.clear();
        seats.clear();
        outlined.clear();
        return count;
    }

    return Object.freeze({
        register,
        unregister,
        get: (id: string) => interactions.get(String(id || "").trim()) || null,
        list: (resource?: string) => [...interactions.values()].filter((definition) => !resource || definition.resource === resource),
        trigger,
        sync,
        status: () => ({ state: stopped ? "stopped" as const : "ready" as const, interactions: interactions.size, activePlayers: activePlayers.size, lockedInteractions: lockedInteractions.size, revision, uptimeMs: now() - startedAt }),
        unregisterResource,
        disconnect,
        stand,
        setOutlines,
        stop,
    });
}

export = { createInteractService, distance };
