export interface HmpWebhookField {
    name: string;
    value: string;
    inline?: boolean;
}

export interface HmpWebhookMessage {
    content?: string;
    title?: string;
    description?: string;
    color?: number;
    fields?: ReadonlyArray<HmpWebhookField>;
    footer?: string;
    timestamp?: string;
    username?: string;
    avatarUrl?: string;
}

export interface HmpWebhookDestinationStatus {
    id: string;
    provider: string;
    enabled: boolean;
    configured: boolean;
    pending: number;
    sending: boolean;
    accepted: number;
    delivered: number;
    failed: number;
    dropped: number;
    lastStatus: number | null;
    lastError: string;
}

export interface HmpWebhooksStatus {
    state: "ready" | "stopped";
    enabled: boolean;
    uptimeMs: number;
    destinations: HmpWebhookDestinationStatus[];
}

export interface HmpWebhooks {
    /** Queue a normalized rich message for a configured destination. */
    send(destination: string, message: HmpWebhookMessage): boolean;
    status(): HmpWebhooksStatus;
}
