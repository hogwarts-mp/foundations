import type { HmpCore } from "../../hmp-core/types";
import type { HmpLogger } from "../../hmp-lib/types";
import type { HmpMySQL, HmpMySQLMigration } from "../../hmp-mysql/types";
import type { HmpWorldStateEntry, HmpWorldStatePlayer, HmpWorldStateServer } from "../types";

export interface WorldStateConfig {
    command: string;
    enableCommands: boolean;
    adminGroups: Array<{ key: string; minimumGrade?: number }>;
    breakables: {
        enabled: boolean;
        /** Client reports accepted per player inside `windowMs`; a flood past it is dropped. */
        reportLimit: { limit: number; windowMs: number };
    };
}

export type Database = Pick<HmpMySQL, "query" | "update" | "migrate"> & Partial<Pick<HmpMySQL, "ready">>;

export interface StoredRow {
    system: string;
    key: string;
    value: string;
    updatedByAccountId: number | null;
    updatedAt: string | Date | null;
}

export interface WorldStateRepository {
    start(migrations: HmpMySQLMigration[]): Promise<void>;
    loadAll(): Promise<StoredRow[]>;
    put(system: string, key: string, value: string, actorAccountId: number | null): Promise<void>;
    remove(system: string, key: string): Promise<void>;
    clear(system: string): Promise<number>;
}

export interface WorldStateDependencies<P extends HmpWorldStatePlayer> {
    repository: WorldStateRepository;
    migrations: HmpMySQLMigration[];
    core: Pick<HmpCore<P>, "accounts">;
    players(): P[];
    logger?: Pick<HmpLogger, "warn" | "info">;
    now?: () => number;
}

export interface WorldStateService<P extends HmpWorldStatePlayer> extends HmpWorldStateServer<P> {
    /** Runs migrations and loads the store once; later calls return the same promise. */
    ready(): Promise<void>;
    stop(): void;
}

/** Wire payload of one sync push: every registered system with its `[key, value]` pairs. */
export interface SyncPayload {
    systems: Record<string, Array<[string, string]>>;
}

export interface ChangePayload {
    system: string;
    key: string;
    value: string | null;
    by: number | null;
}

export type EntryList = HmpWorldStateEntry[];
