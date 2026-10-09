import type { HmpCore } from "../../hmp-core/types";
import type { HmpLogger } from "../../hmp-lib/types";
import type { HmpMySQL, HmpMySQLMigration } from "../../hmp-mysql/types";
import type { HmpLootDefinition, HmpLootFamilies, HmpLootItem, HmpLootPlayer, HmpLootRecord, HmpLootServer } from "../types";

export interface LootConfig {
    command: string;
    enableCommands: boolean;
    adminGroups: Array<{ key: string; minimumGrade?: number }>;
    /** true switches that family of the game's own loot off for as long as the resource runs. */
    suppressGameLoot: HmpLootFamilies;
    lootables: HmpLootDefinition[];
    /** How often expired takes are swept, in milliseconds. */
    sweepMs: number;
}

/** The Framework's server-side Lootables builtin, as far as this resource uses it. */
export interface NativeLootables<P> {
    place(kind: string, x: number, y: number, z: number, yaw: number,
        options: { items: HmpLootItem[]; locked?: boolean; mode: "shared" | "perPlayer"; model?: string }): number;
    setItems(id: number, items: HmpLootItem[]): boolean;
    setView(id: number, player: P, view: { items?: HmpLootItem[]; locked?: boolean } | null): boolean;
    remove(id: number): boolean;
}

/** The Framework's World builtin's loot switch. */
export interface NativeWorldLoot {
    readonly lootSuppressed: HmpLootFamilies;
    suppressLoot(families: Partial<HmpLootFamilies>): boolean;
}

export type Database = Pick<HmpMySQL, "query" | "update" | "migrate"> & Partial<Pick<HmpMySQL, "ready">>;

export interface LootRepository {
    start(migrations: HmpMySQLMigration[]): Promise<void>;
    loadAll(): Promise<HmpLootRecord[]>;
    put(record: HmpLootRecord): Promise<void>;
    remove(key: string, characterId: number | null): Promise<void>;
}

export interface LootDependencies<P extends HmpLootPlayer> {
    config: LootConfig;
    lootables: NativeLootables<P>;
    world: NativeWorldLoot;
    repository: LootRepository;
    migrations: HmpMySQLMigration[];
    core: Pick<HmpCore<P>, "characters" | "accounts">;
    players(): P[];
    logger?: Pick<HmpLogger, "warn" | "info">;
    now?: () => number;
    schedule?: (fn: () => void, ms: number) => () => void;
}

export interface LootService<P extends HmpLootPlayer> extends HmpLootServer<P> {
    /** Migrates, loads the takes, switches the game's loot off and places every lootable; once. */
    ready(): Promise<void>;
    /** A Lootables take, from the lootableTaken event. */
    taken(player: P, lootableId: number, items: HmpLootItem[]): Promise<void>;
    /** What this player's current character may take; call when a character loads or unloads. */
    sync(player: P): void;
    stop(): void;
}
