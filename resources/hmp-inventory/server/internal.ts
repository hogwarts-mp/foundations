import type { HmpCore, HmpCoreCharacter, HmpCoreSession } from "../../hmp-core/types";
import type { HmpLibServer, HmpLogger } from "../../hmp-lib/types";
import type { HmpMySQL, HmpMySQLMigration } from "../../hmp-mysql/types";
import type {
    HmpInventoryItemOptions,
    HmpInventoryTransferRequest,
    HmpInventoryTransferResult,
    HmpInventoryUseTarget,
    HmpInventoryView,
    HmpItemDefinition,
    HmpNativeInventoryRow,
} from "../types";

export type Player = HogwartsMpPlayer;
export type Character = HmpCoreCharacter | { id: number };
export type Core = HmpCore<Player>;
export type Database = HmpMySQL;
export type Lib = HmpLibServer<Player>;
export type Logger = Pick<HmpLogger, "error" | "warn" | "info">;

export interface StartingItemEntry {
    name: string;
    amount: number;
    metadata?: Record<string, unknown>;
}

export interface InventoryConfig extends Record<string, unknown> {
    slots: number;
    maxWeight: number;
    autoSaveMs: number;
    allowInventoryCommand: boolean;
    items: unknown[];
    startingItems: StartingItemEntry[];
    ui: {
        url: string;
    };
}

export interface InventoryItemRow {
    slot: number;
    name: string;
    amount: number;
    metadata: Record<string, unknown>;
}

export interface InventoryContainer {
    id: number;
    key: string;
    characterId: number | null;
    label: string;
    slots: number;
    maxWeight: number;
    metadata: Record<string, unknown>;
    items: InventoryItemRow[];
}

export interface ContainerSpec {
    key: string;
    characterId?: number | null;
    label: string;
    slots: number;
    maxWeight: number;
    metadata?: Record<string, unknown>;
}

export interface Repository {
    ensureContainer(spec: ContainerSpec): Promise<InventoryContainer>;
    createNamedContainer(spec: ContainerSpec): Promise<InventoryContainer>;
    getContainer(key: string): Promise<InventoryContainer | null>;
    mutateContainer<T>(key: string, work: (container: InventoryContainer) => T | Promise<T>): Promise<{ container: InventoryContainer; result: T }>;
    mutateContainers<T>(keys: string[], work: (containers: Map<string, InventoryContainer>) => T | Promise<T>): Promise<{ containers: InventoryContainer[]; result: T }>;
    deleteContainer(key: string): Promise<boolean>;
    loadNative(characterId: number): Promise<unknown>;
    saveNative(characterId: number, rows: HmpNativeInventoryRow[]): Promise<HmpNativeInventoryRow[]>;
}

export interface TransferService {
    move(request: HmpInventoryTransferRequest<Player>): Promise<HmpInventoryTransferResult>;
}

export interface NormalizedItemDefinition extends Omit<HmpItemDefinition<Player>, "use" | "nativeId" | "holder" | "aliases"> {
    aliases: ReadonlyArray<string>;
    label: string;
    description: string;
    icon: string;
    category: string;
    kind: "item" | "gear" | "tool" | "mount";
    weight: number;
    maxStack: number;
    unique: boolean;
    usable: boolean;
    consumable: boolean;
    use?: NonNullable<HmpItemDefinition<Player>["use"]>;
    referenceValue?: number;
    nativeId?: string;
    holder?: string;
    resource: string;
    readonly native: boolean;
}

export interface Registry {
    register(raw: unknown): NormalizedItemDefinition;
    unregister(name: string, resource?: string): boolean;
    get(name: string): NormalizedItemDefinition | null;
    fromNative(itemId: string): NormalizedItemDefinition | null;
    list(): NormalizedItemDefinition[];
    removeForResource(resource: string): number;
}

export interface NativeBridge {
    list(player: Player): HmpNativeInventoryRow[];
    attach(player: Player, character: Character): Promise<boolean>;
    save(player: Player, character?: Character | null): Promise<boolean>;
    onUpdated(player: Player, rows: unknown): Promise<boolean>;
    detach(player?: Player | null): boolean;
    give(player: Player, definition: HmpItemDefinition<Player> | null, amount: number, options?: HmpInventoryItemOptions): Promise<number>;
    remove(player: Player, definition: HmpItemDefinition<Player> | null, amount: number, options?: HmpInventoryItemOptions): Promise<number>;
    use(player: Player, definition: HmpItemDefinition<Player> | null, options?: Pick<HmpInventoryItemOptions, "variation">): Promise<boolean>;
    flush(): Promise<void>;
    status(): { active: number; pendingWrites: number };
}

export interface InventoryService {
    api: {
        get(target: Player | number): Promise<HmpInventoryView>;
        add(target: Player | number, name: string, amount?: number, options?: HmpInventoryItemOptions): Promise<number>;
        remove(target: Player | number, name: string, amount?: number, options?: HmpInventoryItemOptions): Promise<number>;
        count(target: Player | number, name: string, options?: HmpInventoryItemOptions): Promise<number>;
        has(target: Player | number, name: string, amount?: number, options?: HmpInventoryItemOptions): Promise<boolean>;
        move(target: Player | number, fromSlot: number, toSlot: number): Promise<boolean>;
        use(player: Player, target: number | HmpInventoryUseTarget): Promise<boolean>;
    };
    ensureCharacter(character: Character): Promise<InventoryContainer>;
    enrichNative(row: HmpNativeInventoryRow): unknown;
    characterKey(id: number): string;
}

export interface InventoryEvents {
    emit(eventName: string, payload: unknown): unknown;
}

export interface CharacterPayload {
    session: HmpCoreSession<Player>;
    character: HmpCoreCharacter;
}

export interface InventoryResourceOptions {
    database: Database;
    repository: Repository;
    registry: Registry;
    inventory: InventoryService;
    transfers: TransferService;
    native: NativeBridge;
    core: Core;
    events: InventoryEvents;
    config: InventoryConfig;
    migrations: HmpMySQLMigration[];
    logger: Logger;
    listPlayers: () => Player[];
}
