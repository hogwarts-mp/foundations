import type { HmpWebhookMessage, HmpWebhooks, HmpWebhooksStatus } from "../types";

export interface Logger {
    debug(...args: unknown[]): unknown;
    info(...args: unknown[]): unknown;
    warn(...args: unknown[]): unknown;
    error(...args: unknown[]): unknown;
}

export interface WebhookDestinationConfig {
    id: string;
    enabled: boolean;
    provider: string;
    url: string;
    urlEnv: string;
    username: string;
    avatarUrl: string;
    minIntervalMs: number;
    queueLimit: number;
    maxAttempts: number;
    retryBaseMs: number;
    requestTimeoutMs: number;
}

export interface WebhookRouteConfig {
    enabled: boolean;
    destination: string;
    only: string[];
}

export interface WebhooksConfig {
    enabled: boolean;
    destinations: Record<string, WebhookDestinationConfig>;
    routes: {
        gauntlet: WebhookRouteConfig;
        activities: WebhookRouteConfig;
        spells: WebhookRouteConfig;
    };
}

export interface ProviderRequest {
    headers: Record<string, string>;
    body: string;
}

export interface WebhookProvider {
    name: string;
    validate(destination: WebhookDestinationConfig): string | null;
    request(destination: WebhookDestinationConfig, message: HmpWebhookMessage): ProviderRequest;
    retryAfter(response: Response): Promise<number | null>;
}

export interface ServiceOptions {
    config: WebhooksConfig;
    logger: Logger;
    providers: ReadonlyArray<WebhookProvider>;
    fetch?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
    now?: () => number;
}

export interface WebhookService extends HmpWebhooks {
    idle(): Promise<void>;
    stop(): number;
}

export interface EventBus {
    on(name: string, handler: (...args: unknown[]) => unknown): unknown;
}

export interface RouteOptions {
    events: EventBus;
    routes: WebhooksConfig["routes"];
    send: HmpWebhooks["send"];
}

export type Status = HmpWebhooksStatus;
