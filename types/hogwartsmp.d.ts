export {};

declare global {
    interface HogwartsMpVector3 {
        x: number;
        y: number;
        z: number;
    }

    interface HogwartsMpPlayerLocation extends HogwartsMpVector3 {
        readonly areaId: string;
        readonly regionId: string;
        readonly destinationId: string | null;
        readonly yaw: number;
        readonly revision: number;
    }

    interface HogwartsMpNativeInventoryRow {
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

    interface HogwartsMpNativeItemOptions {
        variation?: string;
        identified?: boolean;
        equipped?: boolean;
        hoodUp?: boolean;
        stolen?: boolean;
        unique?: boolean;
        keepOnReset?: boolean;
    }

    interface HogwartsMpNativeInventoryResult {
        readonly revision: number;
        readonly rows: number;
        readonly item?: HogwartsMpNativeInventoryRow;
    }

    interface HogwartsMpNativeInventoryApplyError {
        readonly itemId: string;
        readonly holder: string;
        readonly code: string;
    }

    interface HogwartsMpNativeInventoryState {
        readonly items: HogwartsMpNativeInventoryRow[];
        readonly sequence: number;
        readonly appliedRevision: number;
        readonly applyErrors: HogwartsMpNativeInventoryApplyError[];
    }

    interface HogwartsMpInventoryOperationError {
        readonly code: string;
        readonly message: string;
    }

    interface HogwartsMpInventoryRevisionError {
        readonly code: "PLAYER_DISCONNECTED" | "REVISION_NOT_PUBLISHED" | "NATIVE_APPLY_FAILED" | "NATIVE_APPLY_TIMEOUT";
        readonly message: string;
        readonly requestedRevision: number;
        readonly appliedRevision: number;
        readonly applyErrors: HogwartsMpNativeInventoryApplyError[];
    }

    type HogwartsMpNativeInventoryCallback<TResult = HogwartsMpNativeInventoryResult> = (error: HogwartsMpInventoryOperationError | null, result: TResult | null) => void;

    type HogwartsMpInventoryPatchOperation =
        | ({ op: "give"; itemId: string; count?: number } & HogwartsMpNativeItemOptions)
        | { op: "remove"; itemId: string; count?: number; variation?: string; unique?: boolean }
        | { op: "move"; itemId: string; count?: number; fromHolder: string; toHolder: string; variation?: string; unique?: boolean };

    interface HogwartsMpInventoryPatchOptions { expectedRevision?: number }

    interface HogwartsMpInventoryMoveOptions extends HogwartsMpInventoryPatchOptions {
        fromHolder: string;
        toHolder: string;
        count?: number;
        variation?: string;
        unique?: boolean;
    }

    interface HogwartsMpNativeInventoryAdoptionOptions {
        additionsOnly?: true;
        holders?: string[];
        itemIds?: string[];
    }

    interface HogwartsMpNativeInventory {
        readonly revision: number;
        list(): HogwartsMpNativeInventoryRow[];
        count(itemId: string): number;
        has(itemId: string, amount?: number): boolean;
        clear(callback?: HogwartsMpNativeInventoryCallback): void;
        native(): HogwartsMpNativeInventoryState | null;
        waitForRevision(revision: number): Promise<HogwartsMpNativeInventoryState>;
        persist(slot: string | boolean, callback?: HogwartsMpNativeInventoryCallback): void;
        replace(rows: HogwartsMpNativeInventoryRow[], callback?: HogwartsMpNativeInventoryCallback): void;
        give(itemId: string, amount: number, options?: HogwartsMpNativeItemOptions, callback?: HogwartsMpNativeInventoryCallback): void;
        remove(itemId: string, amount: number, options?: HogwartsMpNativeItemOptions, callback?: HogwartsMpNativeInventoryCallback): void;
        patch(operations: HogwartsMpInventoryPatchOperation[], options?: HogwartsMpInventoryPatchOptions, callback?: HogwartsMpNativeInventoryCallback): void;
        move(itemId: string, options: HogwartsMpInventoryMoveOptions, callback?: HogwartsMpNativeInventoryCallback): void;
        adoptNative(adoptionId: string, options?: HogwartsMpNativeInventoryAdoptionOptions, callback?: HogwartsMpNativeInventoryCallback): void;
        use(itemId: string, options?: Pick<HogwartsMpNativeItemOptions, "variation">, callback?: HogwartsMpNativeInventoryCallback): number;
    }

    interface HogwartsMpAppearanceOperationResult { readonly revision: number }
    interface HogwartsMpAppearanceOperationError { readonly code: string; readonly message: string }
    type HogwartsMpAppearanceCallback = (error: HogwartsMpAppearanceOperationError | null, result: HogwartsMpAppearanceOperationResult | null) => void;

    interface HogwartsMpTeleportOptions {
        yaw?: number;
        snapToGround?: boolean;
        groundSnapDistance?: number;
    }

    interface HogwartsMpTeleportCompletion {
        requestId: number;
        status: number;
        requested: HogwartsMpVector3 & { yaw: number | null; snapToGround: boolean; groundSnapDistance: number };
        destination: (HogwartsMpVector3 & { yaw: number }) | null;
        groundSnapped: boolean;
    }

    interface HogwartsMpInventoryCatalogDefinition {
        readonly itemId: string;
        readonly itemType: string;
        readonly holder: string;
        readonly maxStack: number;
        readonly kind: "item" | "gear" | "tool" | "mount";
        readonly inventoryable: boolean;
        readonly persistent: boolean;
        readonly consumable: boolean;
        readonly usableFromInventory: boolean;
    }

    interface HogwartsMpInventoryCatalog {
        info(): { readonly schemaVersion: 1; readonly gameBuild: string; readonly definitions: number };
        get(itemId: string): HogwartsMpInventoryCatalogDefinition | null;
        has(itemId: string): boolean;
        list(filter?: {
            inventoryable?: boolean;
            persistent?: boolean;
            consumable?: boolean;
            usableFromInventory?: boolean;
            kind?: "item" | "gear" | "tool" | "mount";
            itemType?: string;
            holder?: string;
        }): HogwartsMpInventoryCatalogDefinition[];
        holderPair(holder: string): { readonly storageHolder: string; readonly activeHolder: string } | null;
    }

    interface HogwartsMpGearOperationError {
        readonly code: "GEAR_NOT_REGISTERED" | "GEAR_NOT_OWNED" | "GEAR_UNKNOWN_SLOT" | "GEAR_SLOT_MISMATCH"
            | "GEAR_SLOT_EMPTY" | "GEAR_UNAVAILABLE" | "GEAR_TIMEOUT" | "GEAR_FAILED";
        readonly message: string;
        readonly slot: string;
    }

    interface HogwartsMpGearOperationResult { readonly slot: string }

    type HogwartsMpGearCallback = (error: HogwartsMpGearOperationError | null, result: HogwartsMpGearOperationResult | null) => void;

    interface HogwartsMpPlayerGear {
        /** Equippable slots, from the game's GearSlotTypes table. Empty until the client has reported. */
        slots(): string[];
        /** Worn gear keyed by slot, null per empty slot. null before the first client report. */
        equipped(): Record<string, HogwartsMpGearItem | null> | null;
        /** Owned gear fitting one slot, the worn one flagged. Slot matched case-insensitively. */
        available(slot: string): HogwartsMpGearItem[];
        /** Wears an item. The game derives the slot; expectedSlot is only asserted against it. */
        equip(itemId: string, options?: { variation?: string; expectedSlot?: string }, callback?: HogwartsMpGearCallback): number;
        /** Clears one slot. Reports GEAR_SLOT_EMPTY rather than succeeding on an empty slot. */
        unequip(slot: string, callback?: HogwartsMpGearCallback): number;
    }

    interface HogwartsMpPlayer {
        id: number;
        nickname: string;
        connected?: boolean;
        position: HogwartsMpVector3;
        virtualWorld?: number;
        house?: "Gryffindor" | "Hufflepuff" | "Ravenclaw" | "Slytherin" | "Unaffiliated";
        steamId?: string;
        discordId?: string;
        hardwareId?: string;
        ping?: number;
        ip?: string;
        inventory?: HogwartsMpNativeInventory;
        gear?: HogwartsMpPlayerGear;
        readonly appearanceRevision?: number;
        getAppearanceBlob?(): string;
        setAppearanceBlob?(appearance: string, callback?: HogwartsMpAppearanceCallback): number;
        getTransmog?(): string;
        setTransmog?(transmog: string): void;
        emit(eventName: string, payload?: unknown): void;
        teleport(x: number, y: number, z: number, options?: HogwartsMpTeleportOptions): number;
        sendChat?(message: string): void;
        kick?(reason?: string): void;
        getIP?(): string;
        hold?(options: { owner: string; x?: number; y?: number; z?: number; radius?: number; radiusZ?: number; mode?: "clamp" | "reject"; rigid?: boolean; ttlMs?: number }): boolean;
        release?(owner: string): boolean;
        holds?(): Array<{ owner: string }>;
        location?(): HogwartsMpPlayerLocation | null;
    }

    interface HogwartsMpNpc {
        readonly id: number;
        readonly enemyId: string;
        readonly disposition: "hostile" | "friendly" | undefined;
        readonly alive: boolean;
        readonly ownerId?: number;
        readonly scale: number;
        readonly health: number;
        readonly maxHealth: number;
        setScale(scale: number): void;
        setMaxHealth(health: number): void;
        setHealth(health: number): void;
        destroy(): void;
        kill(): void;
        setDisposition(disposition: "hostile" | "friendly"): void;
        forceTarget(playerId: number, holdSeconds?: number, applyTicks?: number): void;
    }

    const NPC: {
        new(id: number): HogwartsMpNpc;
        create(
            enemyId: string,
            x: number,
            y: number,
            z: number,
            disposition?: "hostile" | "friendly",
            preferredOwnerId?: number,
        ): HogwartsMpNpc | undefined;
    };
    const NPCManager: { getAll(): HogwartsMpNpc[] };

    interface HogwartsMpEvents {
        on(eventName: "chatCommand", listener: (player: HogwartsMpPlayer, message: string, command: string, args: string[]) => unknown): void;
        on(eventName: "playerConnect" | "playerDisconnect" | "worldReady", listener: (player: HogwartsMpPlayer) => unknown): void;
        on(eventName: "playerInventoryUpdated", listener: (player: HogwartsMpPlayer, rows: unknown) => unknown): void;
        on(eventName: "playerGearChanged", listener: (player: HogwartsMpPlayer) => unknown): void;
        on(eventName: "playerTeleportComplete", listener: (player: HogwartsMpPlayer, requestId: number, status: number, completion: HogwartsMpTeleportCompletion) => unknown): void;
        on(eventName: "playerLocationChanged", listener: (player: HogwartsMpPlayer, current: HogwartsMpPlayerLocation | null, previous: HogwartsMpPlayerLocation | null) => unknown): void;
        on(eventName: "resourceStop", listener: (name?: string) => unknown): void;
        on<TArgs extends unknown[]>(eventName: string, listener: (...args: TArgs) => unknown): void;
        onClient<TArgs extends unknown[]>(eventName: string, listener: (player: HogwartsMpPlayer, ...args: TArgs) => unknown): void;
        emit(eventName: string, ...args: unknown[]): unknown;
        emitServer(eventName: string, ...args: unknown[]): unknown;
        emitAllClients(eventName: string, payload?: unknown): void;
    }

    const Events: HogwartsMpEvents;
    interface HogwartsMpProgressionSetPointsOptions {
        preserveTalentPoints?: boolean;
        source?: string;
        detail?: string;
    }
    interface HogwartsMpProgressionSetPointsResult {
        accepted: boolean;
        requested: number;
        target: number;
        clamped: boolean;
        changed: boolean;
        level: number;
        points: number;
        talentPoints: number;
    }
    const Progression: {
        getLevel(): number;
        getPoints(): number;
        setLevel(level: number): boolean;
        addExperience(points: number, source?: string, detail?: string): boolean;
        setPoints(points: number, options?: HogwartsMpProgressionSetPointsOptions): HogwartsMpProgressionSetPointsResult | null;
        getLevelBounds(level: number): { start: number; end: number } | null;
    };
    interface HogwartsMpTalentEntry {
        id: string;
        type: string;
        category: string;
        ability: string;
        level: number;
        levelRequirement: number;
        lockId: string;
        prerequisite: string;
        state: "unavailable" | "available" | "purchased" | "upgradeUnavailable";
    }
    const Talents: {
        available(): boolean;
        list(category?: string): HogwartsMpTalentEntry[] | null;
        getPoints(): number;
        addPoints(amount: number): boolean;
        getState(id: string): HogwartsMpTalentEntry["state"] | null;
        has(id: string): boolean;
        getLevel(id: string): number;
        purchase(id: string): boolean;
        upgrade(id: string): boolean;
        setLevel(id: string, level?: number): boolean;
        grant(id: string): boolean;
        abilityTags(): string[];
        remove(id: string): boolean;
        refund(id: string): boolean;
        reset(category?: string): boolean;
    };
    interface HogwartsMpPvpHit {
        casterId: number;
        victimId: number;
        spellId: number;
        spell: string;
        damage: number;
        duration: number;
        victimHp?: number;
        victimMax?: number;
    }
    type HogwartsMpPvpDecision = void | boolean | number | { allow?: boolean; damage?: number; duration?: number; minHp?: number };
    const Pvp: {
        setPolicy(fn?: ((hit: HogwartsMpPvpHit) => HogwartsMpPvpDecision) | null): boolean;
        setDamage(amount: number): number;
        setSpellDamage(spell: string, damage?: number | null): boolean;
        setDuration(seconds: number): number;
        getVitals(playerId: number): { hp: number; max: number; level: number; ageMs: number } | null;
        setTeam(team?: string, playerId?: number): string;
        resetTeam(playerId?: number): string;
        setTargetable(playerId?: number | null, on?: boolean): string;
        kneel(): string;
        startDuelContext(arenaControls?: boolean): string;
        endDuelContext(): string;
        setRegen(enabled: boolean, seconds?: number): string;
        showMeter(playerId?: number | "auto" | null): string;
    };
    const InventoryCatalog: HogwartsMpInventoryCatalog;
    interface HogwartsMpPortraitCaptureOptions {
        subjectId?: number;
        ccd?: string;
        transmog?: string;
        framing?: "face" | "bust" | "waist" | "body";
        pose?: string;
        name?: string;
        gaze?: boolean;
        matte?: boolean;
        size?: number;
    }
    const Portrait: {
        capture(options: HogwartsMpPortraitCaptureOptions): boolean;
        busy(): boolean;
        result(): string;
        lastImage(maxBytes?: number): string;
    };
    const Exports: {
        register<T>(name: string, value: T): void;
    };
    const Imports: {
        get(name: "hmp-lib"): import("../resources/hmp-lib/types").HmpLibServer<HogwartsMpPlayer>;
        get(name: "hmp-mysql"): import("../resources/hmp-mysql/types").HmpMySQL;
        get(name: "hmp-core"): import("../resources/hmp-core/types").HmpCore<HogwartsMpPlayer>;
        get(name: "hmp-houses"): import("../resources/hmp-houses/types").HmpHouses<HogwartsMpPlayer>;
        get(name: "hmp-ui"): import("../resources/hmp-ui/types").HmpUiServer<HogwartsMpPlayer>;
        get(name: "hmp-inventory"): import("../resources/hmp-inventory/types").HmpInventory<HogwartsMpPlayer>;
        get(name: "hmp-interact"): import("../resources/hmp-interact/types").HmpInteractServer<HogwartsMpPlayer>;
        get(name: "hmp-shops"): import("../resources/hmp-shops/types").HmpShops<HogwartsMpPlayer>;
        get(name: "hmp-banking"): import("../resources/hmp-banking/types").HmpBanking<HogwartsMpPlayer>;
        get(name: "hmp-jobs"): import("../resources/hmp-jobs/types").HmpJobs<HogwartsMpPlayer>;
        get(name: "hmp-business"): import("../resources/hmp-business/types").HmpBusinesses<HogwartsMpPlayer>;
        get(name: "hmp-admin"): import("../resources/hmp-admin/types").HmpAdmin<HogwartsMpPlayer>;
        get(name: "hmp-audio"): import("../resources/hmp-audio/types").HmpAudioServer<HogwartsMpPlayer>;
        get(name: "hmp-blips"): import("../resources/hmp-blips/types").HmpBlipsServer<HogwartsMpPlayer>;
        get(name: "hmp-spells"): import("../resources/hmp-spells/types").HmpSpellsServer<HogwartsMpPlayer>;
        get(name: "hmp-activities"): import("../resources/hmp-activities/types").HmpActivities<HogwartsMpPlayer>;
        get(name: "hmp-pvp"): import("../resources/hmp-pvp/types").HmpPvp<HogwartsMpPlayer>;
        get(name: "hmp-duels"): import("../resources/hmp-duels/types").HmpDuels<HogwartsMpPlayer>;
        get(name: "hmp-npcs"): import("../resources/hmp-npcs/types").HmpNpcs;
        get<T = unknown>(name: string): T;
    };
    const PlayerManager: {
        getAll(): HogwartsMpPlayer[];
        getById(id: number): HogwartsMpPlayer | null;
    };
    const Web: {
        createView(url: string, options?: { width?: number; height?: number; x?: number; y?: number; zIndex?: number; visible?: boolean; focus?: boolean }): number;
        destroyView(view: number): boolean;
        on(view: number, eventName: string, listener: (payload?: unknown) => unknown): void;
        off(view: number, eventName: string, listener: (payload?: unknown) => unknown): void;
        emit(view: number, eventName: string, payload?: unknown): boolean;
        showView(view: number): boolean;
        hideView(view: number): boolean;
        focusView(view: number): boolean;
        isViewVisible(view: number): boolean;
        loadURL(view: number, url: string): boolean;
        resizeView(view: number, width: number, height: number): boolean;
        setViewPosition(view: number, x: number, y: number): boolean;
        getScreenSize(): { width: number; height: number };
    };
    const Game: {
        lockControls(locked: boolean): void;
        areControlsLocked(): boolean;
        notify(message: string): void;
    };
    const Key: {
        bind(key: string, state: "down" | "up" | "both", handler: (key: string, state: "down" | "up") => void): boolean;
        bind(key: string, handler: (key: string, state: "down" | "up") => void): boolean;
        unbind(key: string, state?: "down" | "up" | "both", handler?: (key: string, state: "down" | "up") => void): boolean;
        isDown(key: string): boolean;
    };
    const Hud: {
        showPrompt(key: string, label: string, x: number, y: number, z: number): void;
        hidePrompt(): void;
    };
    interface HogwartsMpGearItem {
        readonly itemId: string;
        readonly variation: string;
        readonly slot: string;
        readonly equipped: boolean;
    }

    const LocalPlayer: {
        getPosition(): HogwartsMpVector3 | null;
        getRotation(): { pitch: number; yaw: number; roll: number } | null;
        getControlRotation(): { pitch: number; yaw: number; roll: number } | null;
        /** Equippable gear slots from the game's GearSlotTypes table; empty until the GearManager is up. */
        gearSlots(): string[];
        /** What the local player wears, keyed by slot, null per empty slot. null if the GearManager isn't up. */
        equippedGear(): Record<string, HogwartsMpGearItem | null> | null;
        /** Owned gear fitting one slot, each flagged if worn. null for an unknown slot or no GearManager. */
        availableGear(slot: string): HogwartsMpGearItem[] | null;
        stateInfo: {
            setInvulnerableToDamage(invulnerable: boolean): boolean;
        };
    };
    const WorldObject: {
        create(key: string, model: string | number, options: {
            x?: number;
            y?: number;
            z?: number;
            pitch?: number;
            yaw?: number;
            roll?: number;
            scale?: number;
            collision?: boolean;
            promptText?: string;
            promptHeight?: number;
            promptRange?: number;
        }): unknown;
        destroy(key: string): boolean;
    };
    const Character: {
        create(key: string, characterId: string, options: {
            x?: number;
            y?: number;
            z?: number;
            yaw?: number;
            scale?: number;
            label?: string;
            promptText?: string;
            promptHeight?: number;
            promptRange?: number;
        }): unknown;
        destroy(key: string): boolean;
        isAllowed(characterId: string): boolean;
    };
    const Creator: {
        open(): void;
        isOpen(): boolean;
    };
    const Camera: {
        fade(options: { from: number; to: number; duration: number; hold: boolean; fadeAudio: boolean }): void;
        stopFade(): void;
    };
    const Spells: {
        setPolicy(lockIds: string[], bonusLoadouts?: number): void;
        loadout(loadoutIndex?: number): { index: number; current: number; slots: Array<string | null> } | null;
        setLoadoutSlot(slot: number, spellName: string | null, loadoutIndex?: number, emitAssignmentEvent?: boolean): boolean;
        cast(slot: number): { accepted: boolean; slot: number; spellName: string | null; reason: string | null };
    };
}
