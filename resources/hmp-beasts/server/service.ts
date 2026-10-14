import { randomUUID } from "node:crypto";
import type { HmpBeastContext, HmpBeastGender, HmpBeastInit, HmpBeastPlayer, HmpBeastPosition, HmpBeastsStatus, HmpStoredBeast } from "../types";
import type { BeastsDependencies, BeastsService, NativeCapturedBeast } from "./internal";

/** What one player's game holds for their current character. */
interface PlayerBag {
    characterId: number;
    /** The game's bag entry id for each stored beast's uid; entry ids are only good for this connection. */
    entries: Map<number, string>;
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const copy = (beast: HmpStoredBeast): HmpStoredBeast => ({ ...beast });
/** How far in front of the player `bag.release` lets a beast go, in game units (centimetres). */
const RELEASE_DISTANCE = 300;

function createBeastService<P extends HmpBeastPlayer>(deps: BeastsDependencies<P>): BeastsService<P> {
    const { config, native, repository, core } = deps;
    const now = deps.now || Date.now;
    const uid = deps.uid || randomUUID;
    const startedAt = now();
    let state: HmpBeastsStatus["state"] = "starting";
    let lastError = "";
    let readyPromise: Promise<void> | null = null;
    const bags = new Map<number, PlayerBag>();
    // Bumped on every attach and detach, so a bag still loading for a character the player has left gives up.
    const generations = new Map<number, number>();
    // Only while a character is loaded; everything else reads the database.
    const cache = new Map<number, HmpStoredBeast[]>();
    // Saves for one character run one after another, so an older bag never lands on a newer one.
    const writes = new Map<number, Promise<void>>();

    const warn = (message: string) => deps.logger?.warn(message);
    // A function, not a narrowed read: stop() can land during any await.
    const stopped = () => state === "stopped";
    const bump = (playerId: number) => {
        const next = (generations.get(playerId) || 0) + 1;
        generations.set(playerId, next);
        return next;
    };
    const characterOf = (player: P): number | null => core.characters.active(player)?.id ?? null;
    const onlinePlayerOf = (characterId: number): P | null => deps.players().find((player) => bags.get(player.id)?.characterId === characterId) ?? null;

    async function settled(): Promise<void> {
        if (state === "starting" && readyPromise) await readyPromise.catch(() => undefined);
    }

    async function storedOrNull(characterId: number): Promise<HmpStoredBeast[] | null> {
        const cached = cache.get(characterId);
        if (cached) return cached;
        await writes.get(characterId)?.catch(() => undefined);
        return repository.load(characterId);
    }
    const stored = async (characterId: number): Promise<HmpStoredBeast[]> => (await storedOrNull(characterId)) ?? [];

    function persist(characterId: number, beasts: HmpStoredBeast[]): Promise<void> {
        const snapshot = beasts.map(copy);
        const previous = writes.get(characterId) || Promise.resolve();
        const next = previous.catch(() => undefined).then(() => repository.save(characterId, snapshot));
        writes.set(characterId, next);
        next.then(
            () => { if (writes.get(characterId) === next) writes.delete(characterId); },
            (error) => {
                lastError = `Could not save the bag of character ${characterId}: ${messageOf(error)}`;
                warn(lastError);
                if (writes.get(characterId) === next) writes.delete(characterId);
            },
        );
        return next;
    }

    function giveToGame(player: P, bag: PlayerBag, beast: HmpStoredBeast): boolean {
        if (!native) return false;
        try {
            const entry = native.giveCaptured(player, {
                species: beast.species,
                gender: beast.gender,
                ...(beast.color ? { color: beast.color } : {}),
                ...(beast.name ? { name: beast.name } : {}),
            });
            if (!entry) return false;
            bag.entries.set(entry.id, beast.uid);
            if (!beast.color) beast.color = entry.color;
            return true;
        } catch (error) {
            warn(`Could not put ${beast.species} ${beast.uid} into #${player.id}'s bag: ${messageOf(error)}`);
            return false;
        }
    }

    function takeFromGame(player: P, entryId: number): void {
        if (!native) return;
        try { native.takeCaptured(player, entryId); }
        catch (error) { warn(`Could not take bag entry ${entryId} from #${player.id}: ${messageOf(error)}`); }
    }

    async function attachNow(player: P, characterId: number, generation = bump(player.id), adopt = false): Promise<void> {
        if (state === "stopped") return;
        let row: HmpStoredBeast[] | null;
        try { row = await storedOrNull(characterId); }
        catch (error) {
            lastError = `Could not load the bag of character ${characterId}: ${messageOf(error)}`;
            warn(lastError);
            return;
        }
        if (generations.get(player.id) !== generation || stopped()) return;
        const bag: PlayerBag = { characterId, entries: new Map() };
        bags.set(player.id, bag);
        if (native && row === null && adopt) {
            // Started mid-session with nothing stored for this character yet: keep what its game already holds.
            const kept = native.bagOf(player).map((entry): HmpStoredBeast => {
                const beast = { uid: uid(), species: entry.species, color: entry.color, gender: entry.gender, name: entry.name || "", caughtAt: now() };
                bag.entries.set(entry.id, beast.uid);
                return beast;
            });
            cache.set(characterId, kept);
            if (kept.length) await persist(characterId, kept).catch(() => undefined);
            return;
        }
        const beasts = row ?? [];
        cache.set(characterId, beasts);
        if (!native) return;
        // Whatever this connection's bag already holds (a restart with a stored bag, a switch whose unload went unseen)
        // gives way to what is stored, so nothing is doubled.
        for (const entry of native.bagOf(player)) takeFromGame(player, entry.id);
        let rolled = false;
        for (const beast of beasts) {
            const hadColor = Boolean(beast.color);
            if (giveToGame(player, bag, beast) && !hadColor) rolled = true;
        }
        if (rolled) await persist(characterId, beasts).catch(() => undefined);
    }

    function respawn(player: P, beast: Pick<HmpStoredBeast, "species" | "gender" | "color" | "name">, at: HmpBeastPosition, yaw?: number): number | null {
        if (!config.release.respawn || !native) return null;
        try {
            const spawned = native.create(beast.species, {
                x: at.x, y: at.y, z: at.z,
                ...(yaw === undefined ? {} : { yaw }),
                gender: beast.gender,
                ...(beast.color ? { color: beast.color } : {}),
                ...(beast.name ? { name: beast.name } : {}),
                preferredOwnerId: player.id,
            });
            if (config.release.capturable) spawned.capturable = true;
            return spawned.id;
        } catch (error) {
            warn(`Could not bring back the ${beast.species} #${player.id} released: ${messageOf(error)}`);
            return null;
        }
    }

    /** Drops a beast's game entry, if this connection's bag holds one. */
    function unmap(player: P | null, bag: PlayerBag | undefined, beastUid: string): boolean {
        if (!player || !bag) return false;
        for (const [entryId, entryUid] of bag.entries) {
            if (entryUid !== beastUid) continue;
            takeFromGame(player, entryId);
            bag.entries.delete(entryId);
            return true;
        }
        return false;
    }

    function resolve(target: P | number): { characterId: number; player: P | null } {
        if (typeof target === "number") {
            if (!Number.isSafeInteger(target) || target <= 0) throw new TypeError("A character id must be a positive integer");
            return { characterId: target, player: onlinePlayerOf(target) };
        }
        const loaded = bags.get(target.id);
        const characterId = loaded?.characterId ?? characterOf(target);
        if (characterId === null) throw new Error(`${target.nickname} has no character loaded`);
        return { characterId, player: loaded?.characterId === characterId ? target : null };
    }

    function ensureUsable(): void {
        if (state === "stopped") throw new Error("hmp-beasts is stopped");
        if (state === "starting") throw new Error("hmp-beasts is not ready yet");
    }

    function validate(init: HmpBeastInit): { species: string; color: string; gender: HmpBeastGender | undefined; name: string } {
        if (!init || typeof init !== "object") throw new TypeError("A beast must be an object");
        const species = typeof init.species === "string" ? init.species.trim() : "";
        if (!species) throw new TypeError("beast.species is required");
        if (init.gender !== undefined && init.gender !== "male" && init.gender !== "female") throw new TypeError('beast.gender must be "male" or "female"');
        if (init.color !== undefined && typeof init.color !== "string") throw new TypeError("beast.color must be a string");
        if (init.name !== undefined && typeof init.name !== "string") throw new TypeError("beast.name must be a string");
        if (init.name && Buffer.byteLength(init.name, "utf8") > 64) throw new RangeError("beast.name is over 64 bytes");
        const catalog = native?.catalog?.();
        if (catalog) {
            const info = catalog.find((entry) => entry.id === species);
            if (!info) throw new TypeError(`Unknown beast species '${species}'`);
            if (init.color && !info.colors.some((color) => color.id === init.color)) throw new TypeError(`${species} has no colour '${init.color}'`);
        }
        return { species, color: init.color || "", gender: init.gender, name: init.name || "" };
    }

    const describe = (context?: HmpBeastContext<P>) => context?.resource ? ` for ${context.resource}${context.reason ? ` (${context.reason})` : ""}` : "";

    const service: BeastsService<P> = {
        bag: Object.freeze({
            async list(target: P | number) {
                ensureUsable();
                return (await stored(resolve(target).characterId)).map(copy);
            },
            async give(target: P | number, init: HmpBeastInit, context?: HmpBeastContext<P>) {
                ensureUsable();
                const value = validate(init);
                const { characterId, player } = resolve(target);
                const beasts = await stored(characterId);
                const beast: HmpStoredBeast = {
                    uid: uid(),
                    species: value.species,
                    color: value.color,
                    gender: value.gender ?? (Math.random() < 0.5 ? "male" : "female"),
                    name: value.name,
                    caughtAt: now(),
                };
                if (player) giveToGame(player, bags.get(player.id)!, beast);
                beasts.push(beast);
                await persist(characterId, beasts);
                deps.logger?.info(`Gave a ${beast.species} to character ${characterId}${describe(context)}`);
                return copy(beast);
            },
            async take(target: P | number, beastUid: string, context?: HmpBeastContext<P>) {
                ensureUsable();
                const { characterId, player } = resolve(target);
                const beasts = await stored(characterId);
                const index = beasts.findIndex((beast) => beast.uid === beastUid);
                if (index < 0) return false;
                const [beast] = beasts.splice(index, 1);
                unmap(player, player ? bags.get(player.id) : undefined, beastUid);
                await persist(characterId, beasts);
                deps.logger?.info(`Took a ${beast.species} from character ${characterId}${describe(context)}`);
                return true;
            },
            async release(player: P, beastUid: string, context?: HmpBeastContext<P>) {
                ensureUsable();
                const bag = bags.get(player.id);
                if (!bag) throw new Error(`${player.nickname} has no character loaded`);
                const where = deps.positionOf(player);
                if (!where) throw new Error(`${player.nickname}'s position is not known yet`);
                const beasts = await stored(bag.characterId);
                if (bags.get(player.id) !== bag) throw new Error(`${player.nickname} left that character`);
                const index = beasts.findIndex((beast) => beast.uid === beastUid);
                if (index < 0) return null;
                const [beast] = beasts.splice(index, 1);
                unmap(player, bag, beastUid);
                await persist(bag.characterId, beasts);
                // In front of the player and facing them, so it does not spawn inside them.
                const radians = where.yaw * Math.PI / 180;
                const at = { x: where.x + Math.cos(radians) * RELEASE_DISTANCE, y: where.y + Math.sin(radians) * RELEASE_DISTANCE, z: where.z };
                const respawnedBeastId = respawn(player, beast, at, where.yaw + 180);
                deps.logger?.info(`Released a ${beast.species} from character ${bag.characterId}${describe(context)}`);
                deps.emit("hmp:beasts:released", { player, characterId: bag.characterId, beast: copy(beast), at, respawnedBeastId, source: "api" });
                return { beast: copy(beast), respawnedBeastId };
            },
            async rename(target: P | number, beastUid: string, name: string, context?: HmpBeastContext<P>) {
                ensureUsable();
                if (typeof name !== "string") throw new TypeError("A beast name must be a string");
                const next = name.trim();
                if (Buffer.byteLength(next, "utf8") > 64) throw new RangeError("beast.name is over 64 bytes");
                const { characterId, player } = resolve(target);
                const beasts = await stored(characterId);
                const beast = beasts.find((entry) => entry.uid === beastUid);
                if (!beast) return null;
                if (beast.name === next) return copy(beast);
                beast.name = next;
                // The game's bag has no rename, so its entry is swapped for one carrying the new name.
                const bag = player ? bags.get(player.id) : undefined;
                if (player && bag && unmap(player, bag, beastUid)) giveToGame(player, bag, beast);
                await persist(characterId, beasts);
                deps.logger?.info(`Renamed a ${beast.species} of character ${characterId}${describe(context)}`);
                return copy(beast);
            },
        }),

        status: () => ({ state, lastError, loadedBags: bags.size, uptimeMs: now() - startedAt }),

        ready() {
            readyPromise ??= (async () => {
                try { await repository.start(deps.migrations); }
                catch (error) {
                    state = "degraded";
                    lastError = messageOf(error);
                    throw error;
                }
                state = native ? "ready" : "degraded";
                if (!native) lastError = "this server build has no beast capture; bags are not kept";
                for (const player of deps.players()) {
                    const characterId = characterOf(player);
                    if (characterId !== null) await attachNow(player, characterId, bump(player.id), true);
                }
            })();
            return readyPromise;
        },

        async attach(player: P, characterId: number) {
            // Taken before waiting on startup, so an unload during the wait still cancels this load.
            const generation = bump(player.id);
            await settled();
            if (generations.get(player.id) !== generation) return;
            await attachNow(player, characterId, generation);
        },

        detach(player: P) {
            bump(player.id);
            const bag = bags.get(player.id);
            if (!bag) return;
            bags.delete(player.id);
            for (const entryId of bag.entries.keys()) takeFromGame(player, entryId);
            cache.delete(bag.characterId);
        },

        async captured(player: P, captured: NativeCapturedBeast) {
            await settled();
            if (state === "stopped") return;
            const bag = bags.get(player.id);
            const characterId = bag?.characterId ?? characterOf(player);
            if (characterId === null) {
                warn(`#${player.id} caught a ${captured.species} with no character loaded; it is not kept`);
                return;
            }
            const beasts = await stored(characterId);
            const beast: HmpStoredBeast = {
                uid: uid(),
                species: captured.species,
                color: captured.color,
                gender: captured.gender,
                name: captured.name || "",
                caughtAt: now(),
            };
            beasts.push(beast);
            bag?.entries.set(captured.id, beast.uid);
            try { await persist(characterId, beasts); }
            catch { return; }
            deps.emit("hmp:beasts:captured", { player, characterId, beast: copy(beast) });
        },

        async released(player: P, released: NativeCapturedBeast, at: HmpBeastPosition) {
            await settled();
            if (state === "stopped") return;
            const bag = bags.get(player.id);
            const characterId = bag?.characterId ?? characterOf(player);
            let beast: HmpStoredBeast | null = null;
            if (characterId !== null) {
                const beasts = await stored(characterId);
                const mapped = bag?.entries.get(released.id);
                bag?.entries.delete(released.id);
                const index = mapped
                    ? beasts.findIndex((entry) => entry.uid === mapped)
                    : beasts.findIndex((entry) => entry.species === released.species && entry.gender === released.gender
                        && entry.color === released.color && entry.name === (released.name || ""));
                if (index >= 0) {
                    beast = beasts.splice(index, 1)[0];
                    await persist(characterId, beasts).catch(() => undefined);
                }
            }
            // The game already let it go, so it comes back whether or not the bag knew it.
            const respawnedBeastId = respawn(player, { ...released, name: released.name || "" }, at);
            if (characterId === null) return;
            const record = beast ?? { uid: "", species: released.species, color: released.color, gender: released.gender, name: released.name || "", caughtAt: 0 };
            deps.emit("hmp:beasts:released", { player, characterId, beast: copy(record), at: { x: at.x, y: at.y, z: at.z }, respawnedBeastId, source: "fieldGuide" });
        },

        disconnect(player: P) {
            bump(player.id);
            const bag = bags.get(player.id);
            if (!bag) return;
            bags.delete(player.id);
            cache.delete(bag.characterId);
        },

        stop() {
            state = "stopped";
            bags.clear();
            cache.clear();
        },
    };
    return service;
}

export = { createBeastService };
