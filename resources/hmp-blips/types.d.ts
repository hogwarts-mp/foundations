import type { HmpCore } from "../hmp-core/types";

export interface HmpBlipPosition { x: number; y: number; z: number }

export interface HmpBlipPlayer {
    id: number;
    nickname: string;
    connected?: boolean;
    position: HmpBlipPosition;
    virtualWorld?: number;
    emit(eventName: string, payload?: unknown): void;
    sendChat?(message: string): void;
    location?(): HogwartsMpPlayerLocation | null;
}

export interface HmpBlipOwner {
    resource: string;
    id: string;
}

export interface HmpBlipGroupRequirement {
    key: string;
    minimumGrade?: number;
}

export type HmpBlipPlayerReference<P = HmpBlipPlayer> = P | number;
export type HmpBlipPlayerSource<P = HmpBlipPlayer> = Iterable<HmpBlipPlayerReference<P>> | (() => Iterable<HmpBlipPlayerReference<P>> | Promise<Iterable<HmpBlipPlayerReference<P>>>);

export interface HmpBlipSelector<P = HmpBlipPlayer> {
    players?: "all" | HmpBlipPlayerSource<P>;
    groups?: ReadonlyArray<HmpBlipGroupRequirement>;
    groupMode?: "any" | "all";
    areaId?: string;
    regionId?: string;
    virtualWorld?: number;
    where?: (player: P) => boolean | Promise<boolean>;
}

export type HmpBlipAudience<P = HmpBlipPlayer> = "all" | HmpBlipPlayerSource<P> | HmpBlipSelector<P>;
export type HmpBlipColor = readonly [number, number, number] | readonly [number, number, number, number] | { r: number; g: number; b: number; a?: number };

export interface HmpBlipMarkerDefinition<P = HmpBlipPlayer> extends HmpBlipOwner {
    kind: "marker" | "circle";
    position: HmpBlipPosition;
    /** Search-circle radius in metres. */
    radius?: number;
    icon?: string;
    label?: string;
    showOnHud?: boolean;
    showDistance?: boolean;
    /** Seconds. Omitted uses the server default; zero requests permanence. */
    ttl?: number;
    audience?: HmpBlipAudience<P>;
    areaId?: string;
    regionId?: string;
    virtualWorld?: number;
}

export interface HmpBlipMarkerInfo extends HmpBlipOwner {
    key: string;
    kind: "marker" | "circle";
    position: HmpBlipPosition;
    radius?: number;
    icon: string;
    label: string;
    showOnHud: boolean;
    showDistance: boolean;
    ttl: number;
    expiresAt: number | null;
    scoped: boolean;
    areaId?: string;
    regionId?: string;
    virtualWorld?: number;
}

export interface HmpBlipPlayerGroupDefinition<P = HmpBlipPlayer> extends HmpBlipOwner {
    subjects?: HmpBlipAudience<P>;
    audience?: HmpBlipAudience<P>;
    color?: HmpBlipColor;
    priority?: number;
    sameArea?: boolean;
    sameRegion?: boolean;
    sameVirtualWorld?: boolean;
}

export interface HmpBlipPlayerGroupInfo extends HmpBlipOwner {
    key: string;
    color: [number, number, number, number] | null;
    priority: number;
    scopedSubjects: boolean;
    scopedAudience: boolean;
    sameArea: boolean;
    sameRegion: boolean;
    sameVirtualWorld: boolean;
}

export interface HmpBlipMarkersApi<P = HmpBlipPlayer> {
    upsert(definition: HmpBlipMarkerDefinition<P>): Promise<HmpBlipMarkerInfo>;
    remove(id: string, resource: string): boolean;
    clear(resource: string): number;
    get(id: string, resource: string): HmpBlipMarkerInfo | null;
    list(resource?: string): HmpBlipMarkerInfo[];
    pulse(id: string, resource: string, pulse?: boolean): boolean;
    sync(player?: P): Promise<number>;
}

export interface HmpBlipPlayersApi<P = HmpBlipPlayer> {
    track(definition: HmpBlipPlayerGroupDefinition<P>): Promise<HmpBlipPlayerGroupInfo>;
    untrack(id: string, resource: string): Promise<boolean>;
    clear(resource: string): Promise<number>;
    get(id: string, resource: string): HmpBlipPlayerGroupInfo | null;
    list(resource?: string): HmpBlipPlayerGroupInfo[];
    refresh(player?: P): Promise<number>;
}

/** The waypoint a player dropped on the game's own map, as their client reported it. */
export interface HmpBlipWaypoint extends HmpBlipPosition {
    /** The game's beacon name of the map icon it was dropped on, such as "FT_HW_GreatHall"; null on open ground. */
    target: string | null;
    /** The map the player was in when they placed it, as `player.location().areaId` names it; left out when unknown. */
    areaId?: string;
}

/** The `hmp:blips:waypoint` event's payload. */
export interface HmpBlipWaypointChange<P = HmpBlipPlayer> {
    player: P;
    waypoint: HmpBlipWaypoint | null;
    previous: HmpBlipWaypoint | null;
}

export interface HmpBlipWaypointShareDefinition<P = HmpBlipPlayer> extends HmpBlipOwner {
    /** Whose waypoint is shared. */
    player: HmpBlipPlayerReference<P>;
    /** Who sees it. The sharer never does: they have the game's own. */
    audience: HmpBlipAudience<P>;
    /** Defaults to the game's waypoint icon. */
    icon?: string;
    /** Defaults to the sharer's nickname. */
    label?: string;
    showOnHud?: boolean;
    showDistance?: boolean;
}

export interface HmpBlipWaypointShareInfo extends HmpBlipOwner {
    key: string;
    playerId: number;
    /** Whether the sharer has a waypoint out, so the audience sees a marker now. */
    shown: boolean;
}

export interface HmpBlipWaypointsApi<P = HmpBlipPlayer> {
    /** The player's own map waypoint as their client last reported it; null without one, or on a host without `Blips.waypoint`. */
    get(player: HmpBlipPlayerReference<P>): HmpBlipWaypoint | null;
    /**
     * Shows the player's waypoint to the audience as a marker owned by resource/id, following it while it moves and
     * hiding it while it is lifted, until unshared, the owning resource stops or the player leaves.
     */
    share(definition: HmpBlipWaypointShareDefinition<P>): Promise<HmpBlipWaypointShareInfo>;
    unshare(id: string, resource: string): boolean;
    clear(resource: string): number;
    list(resource?: string): HmpBlipWaypointShareInfo[];
}

export interface HmpBlipsStatus {
    state: "ready" | "stopped";
    markers: number;
    playerGroups: number;
    expiringMarkers: number;
    /** Players with a map waypoint out. */
    waypoints: number;
    waypointShares: number;
    showAllPlayers: boolean;
    uptimeMs: number;
}

export interface HmpBlipsServer<P = HmpBlipPlayer> {
    markers: HmpBlipMarkersApi<P>;
    players: HmpBlipPlayersApi<P>;
    waypoints: HmpBlipWaypointsApi<P>;
    status(): HmpBlipsStatus;
}

export interface HmpBlipsDependencies<P extends HmpBlipPlayer = HmpBlipPlayer> {
    core: Pick<HmpCore<P>, "groups">;
    players(): P[];
}

export interface HmpBlipsClientStatus {
    state: "ready" | "stopped";
    markers: number;
    coloredPlayers: number;
    trackAllPlayers: boolean;
    uptimeMs: number;
}

export interface HmpBlipsClient {
    status(): HmpBlipsClientStatus;
}
