export interface NativeClientBlips {
    setMarker(key: string, x: number, y: number, z: number, icon?: string, label?: string, showOnHud?: boolean, showDistance?: boolean): boolean;
    setCircle(key: string, x: number, y: number, z: number, radiusMetres?: number): boolean;
    remove(key: string): boolean;
    clear(): void;
    pulseCircle(key: string, pulse?: boolean): boolean;
    setPlayerColor(networkId: number, r?: number, g?: number, b?: number, a?: number): void;
    setTrackedPlayers(networkIds: number[]): void;
    trackAllPlayers(enabled?: boolean): void;
    setHouseTint(enabled?: boolean): boolean;
    setBlipScale(scale: number): void;
    hideBaseIcon(hide?: boolean): void;
    /** Missing on a host without map waypoint reads. */
    waypoint?(): HogwartsMpWaypoint | null;
}

export interface ClientLogger {
    info(...args: unknown[]): unknown;
    warn(...args: unknown[]): unknown;
}
