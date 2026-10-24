export interface HmpInteractVector3 {
    x: number;
    y: number;
    z: number;
}

export interface HmpInteractPlayer {
    id: number;
    nickname?: string;
    connected?: boolean;
    position: HmpInteractVector3;
    virtualWorld?: number;
    emit(eventName: string, payload?: unknown): void;
    location?(): HogwartsMpPlayerLocation | null;
}

export interface HmpInteractionGroupRequirement {
    key: string;
    minimumGrade?: number;
}

export interface HmpInteractionItemRequirement {
    name: string;
    amount?: number;
    metadata?: Record<string, unknown>;
}

export interface HmpInteractionProgress {
    label?: string;
    duration: number;
    canCancel?: boolean;
    cancelLabel?: string;
}

export interface HmpInteractionContext<P = HmpInteractPlayer> {
    player: P;
    character: { id: number; [key: string]: unknown } | null;
    interaction: HmpInteractionDefinition<P>;
    option: HmpInteractionOption<P> | null;
    distance: number;
}

export interface HmpInteractionRequirements<P = HmpInteractPlayer> {
    /** Require an active hmp-core character. */
    character?: boolean;
    groups?: ReadonlyArray<HmpInteractionGroupRequirement>;
    groupMode?: "all" | "any";
    items?: ReadonlyArray<HmpInteractionItemRequirement>;
    /** Return true to allow, false for the default denial, or a string denial message. */
    allow?(context: HmpInteractionContext<P>): boolean | string | Promise<boolean | string>;
}

export interface HmpInteractionOption<P = HmpInteractPlayer> {
    id: string;
    label: string;
    description?: string;
    icon?: string;
    requirements?: HmpInteractionRequirements<P>;
    progress?: HmpInteractionProgress;
    cooldownMs?: number;
    handler(context: HmpInteractionContext<P>): unknown | Promise<unknown>;
}

export interface HmpInteractionWorldObject {
    model: string | number;
    pitch?: number;
    yaw?: number;
    roll?: number;
    scale?: number;
    collision?: boolean;
}

export interface HmpInteractionCharacter {
    /** Human registry character id, e.g. "GerboldOllivander". Must pass `Character.isAllowed`. */
    characterId: string;
    yaw?: number;
    scale?: number;
    /** Nameplate drawn above the head. */
    label?: string;
}

export interface HmpInteractionSeat {
    /** Floor-level sit point in world centimetres, such as a seat mesh's `AnimStart` socket. Within `radius`. */
    position: HmpInteractVector3;
    /** Facing while seated, in degrees; the current facing when omitted. */
    yaw?: number;
    /** AnimSequence path held as the seated pose. */
    clip?: string;
    /** Floor-level point to stand up at, clear of a table; omitted, the player stands up in place. Within `radius`. */
    exit?: HmpInteractVector3;
}

export interface HmpInteractionDefinition<P = HmpInteractPlayer> {
    id: string;
    /** Owning resource, used for safe cleanup when it stops. */
    resource: string;
    label: string;
    description?: string;
    position: HmpInteractVector3;
    /** Server-side activation radius in centimetres. */
    radius?: number;
    /** Client prompt radius in centimetres; cannot exceed the activation radius. */
    promptDistance?: number;
    /** Vertical prompt offset from position in centimetres. */
    promptOffsetZ?: number;
    priority?: number;
    virtualWorld?: number;
    /** Game coordinate-space scope. Matching is case-insensitive. */
    areaId?: string;
    /** Optional game-authored region scope within areaId. */
    regionId?: string;
    cooldownMs?: number;
    /** Only one player may execute this interaction at once. */
    exclusive?: boolean;
    requirements?: HmpInteractionRequirements<P>;
    progress?: HmpInteractionProgress;
    /** Spawn a replicated Framework WorldObject owned by this interaction. */
    object?: HmpInteractionWorldObject;
    /** Spawn a replicated Framework Character (dressed, stationary human) at `position`, owned by this interaction. */
    character?: HmpInteractionCharacter;
    /** Seat the player once the handler succeeds; F stands them up. One player per seat; not with `options`. */
    seat?: HmpInteractionSeat;
    handler?(context: HmpInteractionContext<P>): unknown | Promise<unknown>;
    options?: ReadonlyArray<HmpInteractionOption<P>>;
}

export interface HmpInteractionClientZone {
    id: string;
    label: string;
    position: HmpInteractVector3;
    promptDistance: number;
    promptOffsetZ: number;
    priority: number;
}

export interface HmpInteractStatus {
    state: "ready" | "stopped";
    interactions: number;
    activePlayers: number;
    lockedInteractions: number;
    revision: number;
    uptimeMs: number;
}

export interface HmpInteractServer<P = HmpInteractPlayer> {
    register(definition: HmpInteractionDefinition<P>): () => boolean;
    unregister(id: string, resource?: string): boolean;
    get(id: string): HmpInteractionDefinition<P> | null;
    list(resource?: string): HmpInteractionDefinition<P>[];
    trigger(player: P, id: string): Promise<boolean>;
    sync(player: P): boolean;
    status(): HmpInteractStatus;
}

export interface HmpInteractClient {
    setEnabled(enabled: boolean): boolean;
    status(): { enabled: boolean; ready: boolean; revision: number; interactions: number; active: string | null };
}
