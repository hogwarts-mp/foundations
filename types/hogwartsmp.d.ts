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
        replace(rows: HogwartsMpNativeInventoryRow[], callback?: HogwartsMpNativeInventoryCallback): void;
        give(itemId: string, amount: number, options?: HogwartsMpNativeItemOptions, callback?: HogwartsMpNativeInventoryCallback): void;
        remove(itemId: string, amount: number, options?: HogwartsMpNativeItemOptions, callback?: HogwartsMpNativeInventoryCallback): void;
        patch(operations: HogwartsMpInventoryPatchOperation[], options?: HogwartsMpInventoryPatchOptions, callback?: HogwartsMpNativeInventoryCallback): void;
        move(itemId: string, options: HogwartsMpInventoryMoveOptions, callback?: HogwartsMpNativeInventoryCallback): void;
        adoptNative(adoptionId: string, options?: HogwartsMpNativeInventoryAdoptionOptions, callback?: HogwartsMpNativeInventoryCallback): void;
        use(itemId: string, options?: Pick<HogwartsMpNativeItemOptions, "variation">, callback?: HogwartsMpNativeInventoryCallback): number;
    }

    /**
     * A look as plain ids: the only appearance form exposed to scripts. This is what
     * `Creator.exportLook`, `player.getLook`, and `playerAppearanceChanged` return, and what the
     * matching import APIs accept. It never carries a transmog.
     */
    interface HogwartsMpLook {
        readonly format: "hogwartsmp-look";
        readonly version: number;
        readonly gender: "male" | "female";
        readonly presets: Readonly<Record<string, string>>;
        readonly gear: readonly string[];
        readonly faceGear?: string;
        /** Beard-slot character piece, e.g. `"M_Facial_zBase_FullBeard"`; absent or `""` is clean-shaven. */
        readonly facialHair?: string;
        /** `"hair"` to match the hair, or a `"#rrggbb"` colour; absent keeps the piece's own colour. */
        readonly facialHairColor?: string;
        readonly house?: string;
        readonly scale?: number;
        readonly boneScales?: Readonly<Record<string, number>>;
        readonly voice?: { readonly tone: number; readonly pitch: number };
        readonly name?: { readonly first: string; readonly last: string };
        readonly hood?: boolean;
        readonly wandStyle?: string;
    }
    interface HogwartsMpCreatorCapabilities {
        readonly version: number;
        readonly session: boolean;
        readonly sessionHolder: "none" | "overlay" | "script" | string;
        readonly schema: boolean;
        readonly state: boolean;
        readonly patch: boolean;
        readonly preview: boolean;
        readonly look: boolean;
        /** Creator API 4: the facialHair and facialHairColor categories. Absent on older clients. */
        readonly facialHair?: boolean;
    }
    interface HogwartsMpCreatorCategory {
        readonly options: readonly string[];
        readonly count: number;
    }
    interface HogwartsMpCreatorSchema {
        readonly version: number;
        readonly gender: number;
        readonly categories: Readonly<Record<string, HogwartsMpCreatorCategory>>;
    }
    interface HogwartsMpCreatorState {
        readonly gender: number;
        readonly selections: Readonly<Record<string, string>>;
        readonly faceGear: string;
        readonly facialHair?: string;
        readonly facialHairColor?: string;
        readonly voice?: { readonly tone: number; readonly pitch: number };
        readonly name?: { readonly first: string; readonly last: string };
        readonly change?: { readonly category: string; readonly id: string; readonly ok: boolean };
    }
    interface HogwartsMpAppearanceOperationResult { readonly revision: number }
    interface HogwartsMpAppearanceOperationError { readonly code: string; readonly message: string }
    type HogwartsMpAppearanceCallback = (error: HogwartsMpAppearanceOperationError | null, result: HogwartsMpAppearanceOperationResult | null) => void;

    interface HogwartsMpTeleportOptions {
        yaw?: number;
        snapToGround?: boolean;
        groundSnapDistance?: number;
    }

    /** An Overland point a world load stands a player on (World.setSpawn, player.setSpawn), facing `yaw` degrees (default 0). */
    interface HogwartsMpSpawnPoint {
        position: HogwartsMpVector3;
        yaw?: number;
    }

    interface HogwartsMpTeleportCompletion {
        requestId: number;
        status: number;
        requested: HogwartsMpVector3 & { yaw: number | null; snapToGround: boolean; groundSnapDistance: number };
        destination: (HogwartsMpVector3 & { yaw: number }) | null;
        groundSnapped: boolean;
    }

    /** Where player.travelToMap stands the player: a position, or a PlayerStart tag; neither is the map's own start. */
    interface HogwartsMpMapTravelOptions {
        position?: HogwartsMpVector3;
        yaw?: number;
        playerStart?: string;
        levels?: string[];
    }

    /** How player.moveTo and player.follow walk a player. One drive per player: a new one ends the running one as "replaced". */
    interface HogwartsMpPlayerMoveOptions {
        owner: string;
        gait?: "walk" | "jog";
        speed?: number;
        ttlMs?: number;
        path?: "nav" | "direct";
        lockInput?: boolean;
        acceptRadius?: number;
        distanceCm?: number;
    }

    /** The drive a player is walking, as player.moving() reads it. */
    interface HogwartsMpPlayerMoving {
        readonly owner: string;
        readonly mode: "to" | "follow";
        readonly x?: number;
        readonly y?: number;
        readonly z?: number;
        readonly targetId?: number;
        readonly gait: "walk" | "jog";
        readonly speed: number | null;
        readonly radius: number;
        readonly expiresAt: number;
    }

    /** Why a drive ended. The player's client reports arrived, blocked, targetLost, interrupted, travel and died. */
    type HogwartsMpPlayerMoveEnd = "arrived" | "blocked" | "targetLost" | "interrupted" | "travel" | "died" | "released" | "replaced" | "expired" | "disconnect";

    /** How a travelToMap or travelToPlace request ended. status: 0 arrived, 1 superseded, 2 unavailable, 3 declined, 4 timed out, 5 failed, 6 level failed. */
    interface HogwartsMpMapTravelCompletion {
        requestId: number;
        status: number;
        map: string;
        place: string | null;
        areaId: string | null;
        destination: (HogwartsMpVector3 & { yaw: number }) | null;
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
        /** The game's `ItemDefinition.EconomyValue`, when the host catalog exposes it. */
        readonly economyValue?: number;
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
        /** How much of their worn gear's Offense, Defense and Cooldown this player gets, 0-1 (see setGearStatMultiplier). */
        readonly gearStatMultiplier?: number;
        /** 0 makes worn gear cosmetic, 1 is native; null restores server.json's `mod.gearStatMultiplier`. Throws outside 0-1. */
        setGearStatMultiplier?(multiplier: number | null): void;
        /** Whether this player's worn gear traits apply (see setGearTraits). */
        readonly gearTraits?: boolean;
        /** false strips the traits of this player's worn gear; null restores server.json's `mod.gearTraits`. */
        setGearTraits?(on: boolean | null): void;
        readonly appearanceRevision?: number;
        getLook?(): HogwartsMpLook | null;
        setLook?(look: HogwartsMpLook | string, callback?: HogwartsMpAppearanceCallback): number;
        getTransmog?(): string;
        setTransmog?(transmog: string): void;
        emit(eventName: string, payload?: unknown): void;
        teleport(x: number, y: number, z: number, options?: HogwartsMpTeleportOptions): number;
        /** Where this player's loads stand them, ahead of World.spawn: the connect load if set in playerConnect, then respawns without a position. null falls back to World.spawn. */
        setSpawn?(spawn: HogwartsMpSpawnPoint | null): void;
        /** Loads a map by package path on this player's client; the request id is reported by playerMapTravelComplete. */
        travelToMap?(map: string, options?: HogwartsMpMapTravelOptions): number;
        /** Map travel to a place the game builds from several maps; 0 when the name is no place. */
        travelToPlace?(name: "intro.gringotts" | "intro.vault" | "intro.cliffside"): number;
        sendChat?(message: string): void;
        kick?(reason?: string): void;
        getIP?(): string;
        hold?(options: { owner: string; x?: number; y?: number; z?: number; radius?: number; radiusZ?: number; mode?: "clamp" | "reject"; ttlMs?: number }): boolean;
        release?(owner: string): boolean;
        holds?(): Array<{ owner: string }>;
        /** Walks this player to a point with the game's own walk; false without a live character. Ends with playerMoveEnded. */
        moveTo?(x: number, y: number, z: number, options: HogwartsMpPlayerMoveOptions): boolean;
        /** Walks this player after another, distanceCm behind, until stopped; a follow never arrives. */
        follow?(target: HogwartsMpPlayer | number, options: HogwartsMpPlayerMoveOptions): boolean;
        /** Ends the drive as "released", only this owner's when given; false when none matched. */
        stopMoving?(owner?: string): boolean;
        moving?(): HogwartsMpPlayerMoving | null;
        location?(): HogwartsMpPlayerLocation | null;
        setHealthRecovery?(on: boolean): void;
        /** Allows or stops this player's own fast travel from their map, for this connection. On by default. */
        setFastTravelEnabled?(on: boolean): void;
        getFastTravelEnabled?(): boolean;
        /** Carries this player's health over map loads; a respawn after a death still starts full. Off by default. */
        setKeepHealthOnTravel?(on: boolean): void;
        getKeepHealthOnTravel?(): boolean;
        /** Stands a kneeling player up now; false when they are not kneeling. A kneel held by `kneelSeconds: 0` waits for this. */
        endKneel?(): boolean;
        /** Takes this player out of player collision (World.setPlayerCollision) or puts them back; server-owned. */
        setCollidable?(collidable: boolean): void;
        /** Whether this player takes part in player collision; true unless setCollidable(false). */
        isCollidable?(): boolean;
        /** True from playerDied until the player is back up (playerDownedEnd). */
        isDead?(): boolean;
        /** Stands a dead player up where they lie, with no reload. False unless dead with no respawn or revive on its way. */
        revive?(options?: { health?: number | "max" }): boolean;
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

    /** Server `World.hogwartsExpress`: the train every client draws at one spot; positions are a t from 0 to 1 or a stop id. */
    interface HogwartsMpHogwartsExpress {
        /** Metres of track from t = 0 to t = 1. */
        readonly length: number;
        /** Named spots along the track, such as `hogsmeade`. */
        readonly stops: Array<{ id: string; t: number }>;
        /** Stands the train there (default 0), replacing one already out; trainSpawned follows. */
        spawn(at?: number | string): boolean;
        /** Runs it from where it is and brakes onto the spot; trainStopped follows. */
        moveTo(at: number | string, options?: { speed?: number; accel?: number; decel?: number }): boolean;
        /** Runs it off the far end of the track, where it despawns; trainEnded "end" follows. */
        depart(options?: { speed?: number; accel?: number; decel?: number }): boolean;
        /** Brakes a moving train to a stop, never past a moveTo's spot; `decel: Infinity` stops it dead. */
        halt(options?: { decel?: number }): boolean;
        /** Removes it at once; trainEnded "despawned" follows. */
        despawn(): boolean;
        /** Where it is now; `target` and `seconds` only while it moves. */
        get(): { spawned: boolean; moving: boolean; departing: boolean; t: number; speed: number; target: number | null; seconds: number | null };
    }

    /** Client `Blips.waypoint()`: the local player's map waypoint in world cm; `target` is the map icon's beacon name, null on open ground. */
    interface HogwartsMpWaypoint {
        readonly x: number;
        readonly y: number;
        readonly z: number;
        readonly target: string | null;
    }

    interface HogwartsMpEvents {
        on(eventName: "chatCommand", listener: (player: HogwartsMpPlayer, message: string, command: string, args: string[]) => unknown): void;
        /** Client: the local player placed, moved or removed their map waypoint. */
        on(eventName: "waypointChanged", listener: (waypoint: HogwartsMpWaypoint | null, previous: HogwartsMpWaypoint | null) => unknown): void;
        on(eventName: "playerConnect" | "playerDisconnect" | "worldReady", listener: (player: HogwartsMpPlayer) => unknown): void;
        on(eventName: "playerInventoryUpdated", listener: (player: HogwartsMpPlayer, rows: unknown) => unknown): void;
        on(eventName: "playerGearChanged", listener: (player: HogwartsMpPlayer) => unknown): void;
        on(eventName: "playerAppearanceChanged", listener: (player: HogwartsMpPlayer, look: HogwartsMpLook, revision: number) => unknown): void;
        on(eventName: "playerTeleportComplete", listener: (player: HogwartsMpPlayer, requestId: number, status: number, completion: HogwartsMpTeleportCompletion) => unknown): void;
        on(eventName: "playerMapTravelComplete", listener: (player: HogwartsMpPlayer, requestId: number, status: number, completion: HogwartsMpMapTravelCompletion) => unknown): void;
        on(eventName: "playerHoldEnded", listener: (player: HogwartsMpPlayer, owner: string, reason: string) => unknown): void;
        on(eventName: "playerMoveEnded", listener: (player: HogwartsMpPlayer, owner: string, reason: HogwartsMpPlayerMoveEnd) => unknown): void;
        /** Client: the local player's anchor ended, the frame after; `reason` is "script" for a `releaseAnchor`. */
        on(eventName: "anchorReleased", listener: (reason: string, at: HogwartsMpVector3) => unknown): void;
        on(eventName: "playerLocationChanged", listener: (player: HogwartsMpPlayer, current: HogwartsMpPlayerLocation | null, previous: HogwartsMpPlayerLocation | null) => unknown): void;
        /** A player's own map pick, held until every handler has run; one returning `false` refuses it. */
        on(eventName: "playerFastTravelRequest", listener: (player: HogwartsMpPlayer, request: { destinationId: string; from: "map" }) => boolean | void): void;
        on(eventName: "resourceStop", listener: (name?: string) => unknown): void;
        on(eventName: "pvpDefeat", listener: (victim: HogwartsMpPlayer, killer: HogwartsMpPlayer, kind: "death" | "kneel") => unknown): void;
        on(eventName: "pvpRulesChanged", listener: (rules: HogwartsMpPvpRules) => unknown): void;
        /** A server-defined spell's cast, by id; reported by the caster's client and rate-limited to 4 a second. */
        on(eventName: "playerSpellCast", listener: (player: HogwartsMpPlayer, spell: string, cast: HogwartsMpSpellCastInfo) => unknown): void;
        /** Client: a lesson this resource started ended. */
        on(eventName: "spellLearningFinished", listener: (result: HogwartsMpSpellLearningResult) => unknown): void;
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
        minHp?: number;
        dotSeconds?: number;
        defeat?: "death" | "kneel";
        victimHp?: number;
        victimMax?: number;
    }
    type HogwartsMpPvpDecision = void | boolean | number | { allow?: boolean; damage?: number; duration?: number; minHp?: number };
    interface HogwartsMpPvpRules {
        enabled: boolean;
        who: "none" | "flagged" | "teams" | "everyone";
        aim: "lock" | "skillshot";
        defeat: "death" | "kneel";
        friendlyFire: boolean;
        curses: "on" | "off";
        kneelHp: number;
        flagCombatLockSeconds: number;
        spawnProtectionSeconds: number;
        damageScale: number;
        /** How long a kneel defeat keeps the player down (default 4); 0 holds it until `player.endKneel`. Absent on an older host. */
        kneelSeconds?: number;
    }
    interface HogwartsMpPvpRelation {
        hostile: boolean;
        aim: "lock" | "skillshot";
        defeat: "death" | "kneel";
        reason: string;
    }
    /** Server and client builtins share the global; the server owns who may hurt whom. */
    const Pvp: {
        configure(patch: Partial<HogwartsMpPvpRules>): HogwartsMpPvpRules;
        getRules(): HogwartsMpPvpRules;
        setPair(a: HogwartsMpPlayer | number, b: HogwartsMpPlayer | number, options?: { hostile?: boolean; aim?: "lock" | "skillshot"; defeat?: "death" | "kneel" } | null): boolean;
        relation(a: HogwartsMpPlayer | number, b?: HogwartsMpPlayer | number): HogwartsMpPvpRelation | null;
        setPolicy(fn?: ((hit: HogwartsMpPvpHit) => HogwartsMpPvpDecision) | null): boolean;
        setSpellDamage(spell: string, damage?: number | null): boolean;
        getVitals(playerId: number): { hp: number; max: number; level: number; ageMs: number } | null;
        /** Client: the opponent health meter. */
        showMeter(playerId?: number | "auto" | null): string;
    };
    const InventoryCatalog: HogwartsMpInventoryCatalog;
    interface HogwartsMpPortraitCaptureOptions {
        subjectId?: number;
        look?: HogwartsMpLook | string;
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
        get(name: "hmp-characters"): import("../resources/hmp-characters/types").HmpCharacters<HogwartsMpPlayer>;
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
        get(name: "hmp-world"): import("../resources/hmp-world/types").HmpWorld<HogwartsMpPlayer>;
        get(name: "hmp-express"): import("../resources/hmp-express/types").HmpExpressServer;
        get(name: "hmp-activities"): import("../resources/hmp-activities/types").HmpActivities<HogwartsMpPlayer>;
        get(name: "hmp-pvp"): import("../resources/hmp-pvp/types").HmpPvp<HogwartsMpPlayer>;
        get(name: "hmp-duels"): import("../resources/hmp-duels/types").HmpDuels<HogwartsMpPlayer>;
        get(name: "hmp-npcs"): import("../resources/hmp-npcs/types").HmpNpcs;
        get(name: "hmp-beasts"): import("../resources/hmp-beasts/types").HmpBeastsServer<HogwartsMpPlayer>;
        get<T = unknown>(name: string): T;
    };
    const PlayerManager: {
        getAll(): HogwartsMpPlayer[];
        getById(id: number): HogwartsMpPlayer | null;
    };
    interface HogwartsMpChatOptions {
        author?: string;
        /** Packed 0xRRGGBBAA. */
        color?: number;
    }
    /** Server only. */
    const Chat: {
        sendToAll(text: string, options?: HogwartsMpChatOptions): void;
        sendToPlayer(player: HogwartsMpPlayer, text: string, options?: HogwartsMpChatOptions): void;
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
        setPosition(x: number, y: number, z: number): boolean;
        setCollision(enabled: boolean): boolean;
        /** Shows or hides the local body, wand and held prop on this screen only. Holds through respawns and travel. */
        setVisibility(visible: boolean): boolean;
        clearVelocity(): boolean;
        /** Skips the next landing's fall damage and measures a fall from here, as the game does after a teleport past 1 m. */
        resetFall(): boolean;
        /** Seats the player exactly on a floor-level point, held there with collision on until released; `false` while it cannot. */
        anchor(at: { x: number; y: number; z: number; yaw?: number; camera?: boolean }): boolean;
        /** Ends an anchor, standing up at a floor-level `exit` or in place; `anchorReleased` follows. */
        releaseAnchor(exit?: { x: number; y: number; z: number; yaw?: number }): boolean;
        /** Plays an AnimSequence on the local body, replicated as state; `loop: false, hold: true` holds its last frame, `""` clears it. */
        playClip(clipPath?: string, options?: { loop?: boolean; hold?: boolean; rate?: number }): boolean;
        /** Freezes movement and actions through the game's own suppressor; camera look stays. `null` without a pawn. */
        stopPlayerInput(): boolean | null;
        restorePlayerInput(): boolean | null;
        /** `false` takes this resource's hold on jumping, `true` gives it back; jump stays off while any resource holds. */
        setJumpEnabled(enabled: boolean): void;
        /** False while any resource holds jump off. */
        isJumpEnabled(): boolean;
        /** As `setJumpEnabled`, for sprinting; a sprint already running stops. */
        setSprintEnabled(enabled: boolean): void;
        isSprintEnabled(): boolean;
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
            /** Interest radius in cm, 100-200000: only players this close receive the object. Default 50000. */
            streamRange?: number;
            /** Client cull distance in cm; 0 never culls. Omitted, a mesh never culls. */
            drawDistance?: number;
            /** A looped animation for a skeletal mesh, on the mesh's own skeleton. */
            animation?: string;
            /** A material on every slot of the mesh. */
            material?: string;
            /** An effect each client plays where the object appears, when it streams in within half a second of creation. */
            startFx?: string;
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
        /** @deprecated Use the headless session API with a resource-owned UI. */
        open(): void;
        /** @deprecated Use `commit` or `cancel` and hide the resource-owned UI. */
        close(): void;
        /** @deprecated Use `isActive` and `getCapabilities`. */
        isOpen(): boolean;
        getCapabilities(): HogwartsMpCreatorCapabilities;
        begin(options?: { preserveCurrent?: boolean }): boolean;
        commit(): boolean;
        cancel(): boolean;
        getSchema(): HogwartsMpCreatorSchema | null;
        getState(): HogwartsMpCreatorState | null;
        applyPatch(patch: Record<string, string>): number;
        setVoice(voice: { tone?: number; pitch?: number }): boolean;
        setName(first: string, last?: string): boolean;
        exportLook(): HogwartsMpLook | null;
        importLook(look: HogwartsMpLook | string): boolean;
        isActive(): boolean;
    };
    const CreatorPreview: {
        setCamera(frame: { dist?: number; height?: number; pitch?: number; fov?: number; shift?: number }): void;
        restoreCamera(): void;
        rotate(deltaYaw: number): void;
        freeze(frozen?: boolean): void;
        playIdle(abilityClassPath: string, channel?: "FullBody" | "PartialBody"): boolean;
    };
    /** A shape colour, linear 0-1 (above 1 glows); `a` defaults to 1. */
    interface HogwartsMpShapeColor { r: number; g: number; b: number; a?: number }
    interface HogwartsMpShapeOptions {
        type: "ring" | "sphere" | "box" | "cylinder" | "polygon" | "line";
        /** World cm; with `attachTo`, an offset from it. A ring's or sphere's centre, a cylinder's base. */
        center?: HogwartsMpVector3;
        radius?: number;
        /** Outline width, 0-1000. Default 8. */
        thickness?: number;
        /** Outline colour, default opaque white; `null` draws none. */
        color?: HogwartsMpShapeColor | null;
        /** Colour of what the outline encloses; default none. */
        fill?: HogwartsMpShapeColor | null;
        /** Drop the shape onto the ground below it. */
        ground?: boolean;
    }
    /** Client-only world-space shapes; keys belong to the calling resource, and its shapes go when it stops. */
    const Shapes: {
        /** Creates or replaces a shape. Throws a TypeError on a bad shape, and an Error at 1024 shapes on this client. */
        create(key: string, shape: HogwartsMpShapeOptions): boolean;
        destroy(key: string): boolean;
        /** Destroys every shape this resource made, returning how many. */
        destroyAll(): number;
    };
    const Camera: {
        capture(): {
            position: HogwartsMpVector3;
            rotation: { pitch: number; yaw: number; roll: number };
        } | null;
        fade(options: { from: number; to: number; duration: number; hold: boolean; fadeAudio: boolean }): void;
        stopFade(): void;
    };
    /** What server `Spells.define` takes: a missing stat or part keeps the base spell's, an unknown key throws. */
    interface HogwartsMpSpellDefinitionInput {
        id: string;
        base: string;
        name?: string;
        description?: string;
        icon?: string;
        incantation?: string;
        stats?: Partial<Record<"damage" | "objectDamage" | "cooldown" | "range" | "projectileSpeed" | "projectileGravity" | "duration" | "playerDuration" | "chargeTime" | "impulse", number>>;
        parts?: Partial<Record<"projectile" | "onHit" | "cast" | "muzzle", string>>;
    }
    /** Where a defined spell's cast was aimed: camera yaw in degrees, and the wand tip (the caster's position past 5 m). */
    interface HogwartsMpSpellCastInfo {
        readonly aimYaw: number;
        readonly wand: HogwartsMpVector3;
    }
    /** A defined spell as the server holds it; `lock` is `Spell_<id>`, `base` and parts in the game's spelling. */
    interface HogwartsMpSpellDefinitionInfo extends Required<Pick<HogwartsMpSpellDefinitionInput, "id" | "base" | "name" | "description" | "stats" | "parts">> {
        readonly lock: string;
        readonly icon: string | null;
        readonly incantation: string | null;
    }
    const Spells: {
        setPolicy(lockIds: string[], bonusLoadouts?: number): void;
        loadout(loadoutIndex?: number): { index: number; current: number; slots: Array<string | null> } | null;
        setLoadoutSlot(slot: number, spellName: string | null, loadoutIndex?: number, emitAssignmentEvent?: boolean): boolean;
        cast(slot: number): { accepted: boolean; slot: number; spellName: string | null; reason: string | null };
        /** Server: adds or replaces a spell running a player spell's class, on every client now and later. Throws on a bad definition or past 32. */
        define(definition: HogwartsMpSpellDefinitionInput): HogwartsMpSpellDefinitionInfo;
        /** Server: removes a defined spell for later joiners; connected clients keep it until they reconnect. */
        remove(id: string): boolean;
        /** Server: one defined spell by id, case-blind. */
        get(id: string): HogwartsMpSpellDefinitionInfo | null;
        list(): HogwartsMpSpellDefinitionInfo[];
    };
    /** Client: how a lesson ended, delivered only to the resource that started it. */
    interface HogwartsMpSpellLearningResult {
        readonly requestId: number;
        readonly spell: string;
        readonly status: "completed" | "cancelled" | "failed";
        readonly reason: string | null;
    }
    /** Client: the game's spell lesson, run on this client only; it grants nothing. */
    const SpellLearning: {
        /** A stock lesson or an id this resource defined; one lesson runs client-wide, and a refusal says why. */
        start(spell: string): { readonly started: boolean; readonly requestId: number | null; readonly reason: string | null };
        cancel(requestId: number): boolean;
        /** Adds or replaces one of this resource's lessons (a title, then a stock look, a path, checkpoints...), gone when it stops. */
        define(id: string, lesson: { title: string; [key: string]: unknown }): { readonly ok: boolean; readonly reason: string | null };
        /** False when this resource has no such lesson, or it is running. */
        undefine(id: string): boolean;
        lessons(): string[];
    };
}
