import type { HmpStoredBeast } from "../types";
import type { BeastsRepository, Database } from "./internal";

// A row is ours alone, but tolerate a hand-edited or truncated one: drop what doesn't parse, keep the rest.
function parseBeasts(raw: unknown): HmpStoredBeast[] {
    if (typeof raw !== "string" || !raw) return [];
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return []; }
    if (!Array.isArray(value)) return [];
    const out: HmpStoredBeast[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== "object") continue;
        const row = entry as Record<string, unknown>;
        if (typeof row.uid !== "string" || !row.uid || typeof row.species !== "string" || !row.species) continue;
        out.push({
            uid: row.uid,
            species: row.species,
            color: typeof row.color === "string" ? row.color : "",
            gender: row.gender === "female" ? "female" : "male",
            name: typeof row.name === "string" ? row.name : "",
            caughtAt: Number.isFinite(Number(row.caughtAt)) ? Number(row.caughtAt) : 0,
        });
    }
    return out;
}

function createRepository(database: Database): BeastsRepository {
    return Object.freeze({
        async start(migrations: Parameters<BeastsRepository["start"]>[0]) {
            if (typeof database.ready === "function" && !await database.ready()) throw new Error("hmp-mysql is not ready");
            await database.migrate("hmp-beasts", migrations);
        },
        async load(characterId: number) {
            const raw = await database.scalar("SELECT beasts_json FROM hmp_beast_bags WHERE character_id = ?", [characterId]);
            return raw === null || raw === undefined ? null : parseBeasts(raw);
        },
        async save(characterId: number, beasts: HmpStoredBeast[]) {
            await database.update(
                `INSERT INTO hmp_beast_bags (character_id, beasts_json) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE beasts_json = VALUES(beasts_json)`,
                [characterId, JSON.stringify(beasts)],
            );
        },
    });
}

export = { createRepository, parseBeasts };
