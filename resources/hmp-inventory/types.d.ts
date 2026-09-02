export type HmpInventorySource = "custom" | "native";

export interface HmpNativeInventoryOperationResult {
    readonly revision: number;
    readonly rows: number;
    readonly item?: HmpNativeInventoryRow;
}

export interface HmpNativeInventoryOperationError {
    readonly code: string;
    readonly message: string;
}

export interface HmpNativeInventoryApplyError {
    readonly itemId: string;
    readonly holder: string;
    readonly code: string;
}

export interface HmpNativeInventoryState {
    readonly items: HmpNativeInventoryRow[];
    readonly sequence: number;
    readonly appliedRevision: number;
    readonly applyErrors: HmpNativeInventoryApplyError[];
}

export interface HmpNativeInventoryRevisionError {
    readonly code: "PLAYER_DISCONNECTED" | "REVISION_NOT_PUBLISHED" | "NATIVE_APPLY_FAILED" | "NATIVE_APPLY_TIMEOUT";
    readonly message: string;
    readonly requestedRevision: number;
    readonly appliedRevision: number;
    readonly applyErrors: HmpNativeInventoryApplyError[];
}

export type HmpNativeInventoryCallback<TResult = HmpNativeInventoryOperationResult> = (error: HmpNativeInventoryOperationError | null, result: TResult | null) => void;

export type HmpNativeInventoryPatchOperation =
    | ({ op: "give"; itemId: string; count?: number } & HmpNativeItemOptions)
    | { op: "remove"; itemId: string; count?: number; variation?: string; unique?: boolean }
    | { op: "move"; itemId: string; count?: number; fromHolder: string; toHolder: string; variation?: string; unique?: boolean };

export interface HmpNativeInventoryPatchOptions { expectedRevision?: number }

export interface HmpNativeInventoryMoveOptions extends HmpNativeInventoryPatchOptions {
    fromHolder: string;
    toHolder: string;
    count?: number;
    variation?: string;
    unique?: boolean;
}

export interface HmpNativeInventoryAdoptionOptions {
    additionsOnly?: true;
    holders?: string[];
    itemIds?: string[];
}

export interface HmpNativeInventory {
    readonly revision: number;
    list(): HmpNativeInventoryRow[];
    count(itemId: string): number;
    has(itemId: string, amount?: number): boolean;
    clear(callback?: HmpNativeInventoryCallback): void;
    native(): HmpNativeInventoryState | null;
    waitForRevision(revision: number): Promise<HmpNativeInventoryState>;
    persist(slot: string | boolean, callback?: HmpNativeInventoryCallback): void;
    replace(rows: HmpNativeInventoryRow[], callback?: HmpNativeInventoryCallback): void;
    give(itemId: string, amount: number, options?: HmpNativeItemOptions, callback?: HmpNativeInventoryCallback): void;
    remove(itemId: string, amount: number, options?: HmpNativeItemOptions, callback?: HmpNativeInventoryCallback): void;
    patch(operations: HmpNativeInventoryPatchOperation[], options?: HmpNativeInventoryPatchOptions, callback?: HmpNativeInventoryCallback): void;
    move(itemId: string, options: HmpNativeInventoryMoveOptions, callback?: HmpNativeInventoryCallback): void;
    adoptNative(adoptionId: string, options?: HmpNativeInventoryAdoptionOptions, callback?: HmpNativeInventoryCallback): void;
    use(itemId: string, options?: Pick<HmpNativeItemOptions, "variation">, callback?: HmpNativeInventoryCallback): number;
}

export interface HmpInventoryPlayer {
    id: number;
    nickname?: string;
    emit(event: string, payload?: unknown): void;
    inventory?: HmpNativeInventory;
}

export interface HmpNativeItemOptions {
    variation?: string;
    identified?: boolean;
    equipped?: boolean;
    hoodUp?: boolean;
    stolen?: boolean;
    unique?: boolean;
    keepOnReset?: boolean;
}

export interface HmpNativeInventoryRow {
    itemId: string;
    holder: string;
    count: number;
    variation?: string;
    identified?: boolean;
    equipped?: boolean;
    hoodUp?: boolean;
    stolen?: boolean;
    unique?: boolean;
    keepOnReset?: boolean;
    kind?: "item" | "gear" | "tool" | "mount";
    itemType?: string;
}

export interface HmpInventoryUseContext<P = HmpInventoryPlayer> {
    player: P;
    character: { id: number; [key: string]: unknown };
    item: HmpItemDefinition<P>;
    slot: number;
    metadata: Record<string, unknown>;
    cancelled: boolean;
    consume: boolean;
}

export interface HmpItemDefinition<P = HmpInventoryPlayer> {
    name: string;
    /** Additional lookup names that resolve to this canonical definition without creating another item row. */
    aliases?: ReadonlyArray<string>;
    label?: string;
    description?: string;
    /** Absolute URL or resource URL, such as fw://resources/my-resource/icons/item.png. */
    icon?: string;
    category?: string;
    kind?: "item" | "gear" | "tool" | "mount";
    weight?: number;
    maxStack?: number;
    stack?: number;
    unique?: boolean;
    usable?: boolean;
    consumable?: boolean;
    use?(context: HmpInventoryUseContext<P>): void | Promise<void>;
    /** Setting this makes the item game-native; custom metadata is not stored on native rows. */
    nativeId?: string;
    /** Expected native holder, used for documentation and display. Routing is validated by the Framework catalog. */
    holder?: string;
    /** Owning resource, used for safe cleanup when that resource stops. */
    resource: string;
    readonly native?: boolean;
}

export interface HmpInventoryCustomRow {
    source: "custom";
    slot: number;
    name: string;
    itemId: null;
    label: string;
    description: string;
    icon: string;
    category: string;
    kind: string;
    amount: number;
    weight: number;
    metadata: Record<string, unknown>;
    usable: boolean;
}

export interface HmpInventoryNativeViewRow {
    source: "native";
    slot: null;
    name: string;
    itemId: string;
    label: string;
    description: string;
    icon: string;
    category: string;
    kind: string;
    holder: string;
    amount: number;
    weight: 0;
    variation: string;
    identified: boolean;
    equipped: boolean;
    metadata: Record<string, never>;
    usable: boolean;
}

export type HmpInventoryUseTarget =
    | { source: "custom"; slot: number }
    | { source: "native"; itemId: string; variation?: string };

export interface HmpInventoryView {
    characterId: number;
    container: { key: string; label: string; slots: number; maxWeight: number };
    /** Occupied rows across the unified view: custom container slots plus native holdings. */
    usedSlots: number;
    /** Combined weight of every row in the unified view. Native rows currently contribute 0. */
    weight: number;
    custom: HmpInventoryCustomRow[];
    native: HmpInventoryNativeViewRow[];
    items: Array<HmpInventoryCustomRow | HmpInventoryNativeViewRow>;
}

/** Stable bridge implemented by the bundled Arcanum renderer and replacement inventory pages. */
export type HmpInventoryUiContract = "hmp.inventory.ui/v1";

export interface HmpInventoryUiConfiguration {
    contract: HmpInventoryUiContract;
    /** Resource URL or HTTPS URL loaded by the hmp-inventory client bridge. */
    url: string;
}

export interface HmpInventoryItemOptions {
    metadata?: Record<string, unknown>;
    variation?: string;
    identified?: boolean;
}

export interface HmpItemsApi<P = HmpInventoryPlayer> {
    register(definition: HmpItemDefinition<P>): HmpItemDefinition<P>;
    unregister(name: string, resource?: string): boolean;
    get(name: string): HmpItemDefinition<P> | null;
    fromNative(itemId: string): HmpItemDefinition<P> | null;
    list(): HmpItemDefinition<P>[];
}

export interface HmpInventoryApi<P = HmpInventoryPlayer> {
    get(target: P | number): Promise<HmpInventoryView>;
    add(target: P | number, name: string, amount?: number, options?: HmpInventoryItemOptions): Promise<number>;
    remove(target: P | number, name: string, amount?: number, options?: HmpInventoryItemOptions): Promise<number>;
    count(target: P | number, name: string, options?: HmpInventoryItemOptions): Promise<number>;
    has(target: P | number, name: string, amount?: number, options?: HmpInventoryItemOptions): Promise<boolean>;
    move(target: P | number, fromSlot: number, toSlot: number): Promise<boolean>;
    use(player: P, target: number | HmpInventoryUseTarget): Promise<boolean>;
}

export interface HmpInventoryContainer {
    id: number;
    key: string;
    characterId: number | null;
    label: string;
    slots: number;
    maxWeight: number;
    metadata: Record<string, unknown>;
    items: Array<{ slot: number; name: string; amount: number; metadata: Record<string, unknown> }>;
}

export type HmpInventoryContainerTarget<P = HmpInventoryPlayer> = P | number | string;

export interface HmpInventoryTransferRequest<P = HmpInventoryPlayer> {
    /** Player/character inventory or a named container key. */
    from: HmpInventoryContainerTarget<P>;
    /** Player/character inventory or a named container key. */
    to: HmpInventoryContainerTarget<P>;
    /** Exact custom-item source slot. */
    fromSlot: number;
    /** Positive quantity; omitted moves the whole source stack. */
    amount?: number;
    /** Optional preferred destination slot. It must be empty or a compatible stack. */
    toSlot?: number;
}

export interface HmpInventoryTransferResult {
    item: string;
    amount: number;
    metadata: Record<string, unknown>;
    from: HmpInventoryContainer;
    to: HmpInventoryContainer;
}

export interface HmpInventoryTransfersApi<P = HmpInventoryPlayer> {
    /** Atomically moves a custom item between two durable containers. */
    move(request: HmpInventoryTransferRequest<P>): Promise<HmpInventoryTransferResult>;
}

export interface HmpContainersApi {
    create(spec: { key: string; label?: string; slots?: number; maxWeight?: number; metadata?: Record<string, unknown> }): Promise<HmpInventoryContainer>;
    get(key: string): Promise<HmpInventoryContainer | null>;
    remove(key: string): Promise<boolean>;
}

export interface HmpNativeInventoryApi<P = HmpInventoryPlayer> {
    list(player: P): HmpNativeInventoryRow[];
    save(player: P, character?: { id: number } | null): Promise<boolean>;
    give(player: P, item: string | HmpItemDefinition<P>, amount: number, options?: HmpNativeItemOptions): Promise<number>;
    remove(player: P, item: string | HmpItemDefinition<P>, amount: number, options?: HmpNativeItemOptions): Promise<number>;
    use(player: P, item: string | HmpItemDefinition<P>, options?: Pick<HmpNativeItemOptions, "variation">): Promise<boolean>;
}

export interface HmpInventoryUiApi<P = HmpInventoryPlayer> {
    open(player: P): Promise<HmpInventoryView>;
    close(player: P): boolean;
    refresh(player: P): Promise<boolean>;
    isOpen(player: P): boolean;
}

export interface HmpInventoryStatus {
    state: "starting" | "ready" | "degraded" | "stopped";
    lastError: string;
    itemDefinitions: number;
    openInventories: number;
    readyClients: number;
    native: { active: number; pendingWrites: number };
    uptimeMs: number;
}

export interface HmpInventory<P = HmpInventoryPlayer> {
    items: HmpItemsApi<P>;
    inventory: HmpInventoryApi<P>;
    containers: HmpContainersApi;
    transfers: HmpInventoryTransfersApi<P>;
    native: HmpNativeInventoryApi<P>;
    ui: HmpInventoryUiApi<P>;
    status(): HmpInventoryStatus;
}
