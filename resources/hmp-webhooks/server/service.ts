import type { HmpWebhookField, HmpWebhookMessage, HmpWebhookDestinationStatus } from "../types";
import type {
    ServiceOptions, WebhookDestinationConfig, WebhookProvider, WebhookService,
} from "./internal";

interface QueuedMessage { message: HmpWebhookMessage }
interface Delivery { ok: boolean; status: number | null; error: string }
interface DestinationRuntime {
    config: WebhookDestinationConfig;
    provider: WebhookProvider | null;
    configured: boolean;
    queue: QueuedMessage[];
    sending: boolean;
    drainPromise: Promise<void> | null;
    controllers: Set<AbortController>;
    accepted: number;
    delivered: number;
    failed: number;
    dropped: number;
    lastStatus: number | null;
    lastError: string;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const defaultSleep = (milliseconds: number): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
});

function normalizeField(value: unknown): HmpWebhookField | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const field = value as Record<string, unknown>;
    const name = String(field.name ?? "").trim();
    const content = String(field.value ?? "").trim();
    return name && content ? { name, value: content, inline: field.inline === true } : null;
}

function normalizeMessage(value: unknown): HmpWebhookMessage | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const fields = Array.isArray(raw.fields) ? raw.fields.map(normalizeField).filter((field): field is HmpWebhookField => !!field) : [];
    const message: HmpWebhookMessage = {
        content: String(raw.content ?? "").trim(),
        title: String(raw.title ?? "").trim(),
        description: String(raw.description ?? "").trim(),
        fields,
        footer: String(raw.footer ?? "").trim(),
        timestamp: String(raw.timestamp ?? "").trim(),
        username: String(raw.username ?? "").trim(),
        avatarUrl: String(raw.avatarUrl ?? "").trim(),
        ...(Number.isFinite(Number(raw.color)) ? { color: Number(raw.color) } : {}),
    };
    if (!message.content && !message.title && !message.description && !fields.length) return null;
    return Object.freeze({ ...message, fields: Object.freeze(fields.map((field) => Object.freeze(field))) });
}

function createWebhookService(options: ServiceOptions): WebhookService {
    const { config, logger } = options;
    const fetchRequest = options.fetch || fetch;
    const sleep = options.sleep || defaultSleep;
    const now = options.now || Date.now;
    const startedAt = now();
    let state: "ready" | "stopped" = "ready";
    const isStopped = (): boolean => state === "stopped";
    const providers = new Map(options.providers.map((provider) => [provider.name, provider]));
    const runtimes = new Map<string, DestinationRuntime>();
    const warned = new Set<string>();

    for (const destination of Object.values(config.destinations)) {
        const provider = providers.get(destination.provider) || null;
        const validationError = provider ? provider.validate(destination) : `unknown provider '${destination.provider}'`;
        const runtime: DestinationRuntime = {
            config: destination,
            provider,
            configured: !validationError,
            queue: [], sending: false, drainPromise: null, controllers: new Set(),
            accepted: 0, delivered: 0, failed: 0, dropped: 0,
            lastStatus: null, lastError: validationError || "",
        };
        runtimes.set(destination.id, runtime);
        if (config.enabled && destination.enabled && validationError) {
            logger.warn(`Destination '${destination.id}' disabled: ${validationError}`);
        }
    }

    const backoff = (destination: WebhookDestinationConfig, attempt: number): number =>
        Math.min(60000, destination.retryBaseMs * (2 ** Math.max(0, attempt - 1)));

    async function deliver(runtime: DestinationRuntime, message: HmpWebhookMessage): Promise<Delivery> {
        const provider = runtime.provider!;
        const destination = runtime.config;
        for (let attempt = 1; attempt <= destination.maxAttempts; attempt++) {
            if (isStopped()) return { ok: false, status: null, error: "resource stopped" };
            const controller = new AbortController();
            runtime.controllers.add(controller);
            const timer = setTimeout(() => controller.abort(), destination.requestTimeoutMs);
            timer.unref?.();
            try {
                const outgoing = provider.request(destination, message);
                const response = await fetchRequest(destination.url, {
                    method: "POST",
                    headers: outgoing.headers,
                    body: outgoing.body,
                    signal: controller.signal,
                });
                runtime.lastStatus = response.status;
                if (response.ok) return { ok: true, status: response.status, error: "" };
                const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
                if (retryable && attempt < destination.maxAttempts) {
                    const providerDelay = response.status === 429 ? await provider.retryAfter(response) : null;
                    await sleep(providerDelay ?? backoff(destination, attempt));
                    continue;
                }
                return { ok: false, status: response.status, error: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}` };
            } catch (error) {
                if (isStopped()) return { ok: false, status: null, error: "resource stopped" };
                if (attempt < destination.maxAttempts) {
                    await sleep(backoff(destination, attempt));
                    continue;
                }
                return { ok: false, status: null, error: errorMessage(error) };
            } finally {
                clearTimeout(timer);
                runtime.controllers.delete(controller);
            }
        }
        return { ok: false, status: null, error: "delivery attempts exhausted" };
    }

    async function drain(runtime: DestinationRuntime): Promise<void> {
        while (state === "ready" && runtime.queue.length) {
            const entry = runtime.queue.shift()!;
            const result = await deliver(runtime, entry.message);
            if (result.ok) {
                runtime.delivered++;
                runtime.lastError = "";
            } else if (state === "ready") {
                runtime.failed++;
                runtime.lastError = result.error;
                logger.warn(`Delivery to '${runtime.config.id}' failed: ${result.error}`);
            }
            // Keep the destination in cooldown even when the queue is momentarily empty. A message
            // arriving immediately after the request must not bypass the configured spacing.
            if (state === "ready" && runtime.config.minIntervalMs > 0) {
                await sleep(runtime.config.minIntervalMs);
            }
        }
    }

    function schedule(runtime: DestinationRuntime): void {
        if (runtime.drainPromise || state !== "ready") return;
        runtime.sending = true;
        runtime.drainPromise = drain(runtime).finally(() => {
            runtime.sending = false;
            runtime.drainPromise = null;
            if (state === "ready" && runtime.queue.length) schedule(runtime);
        });
    }

    function send(rawDestination: string, rawMessage: HmpWebhookMessage): boolean {
        if (state !== "ready" || !config.enabled) return false;
        const destination = String(rawDestination || "").trim().toLowerCase();
        const runtime = runtimes.get(destination);
        if (!runtime || !runtime.config.enabled || !runtime.configured) {
            const key = destination || "<empty>";
            if (!warned.has(key)) {
                warned.add(key);
                logger.warn(`Webhook destination '${key}' is unavailable`);
            }
            return false;
        }
        const message = normalizeMessage(rawMessage);
        if (!message) {
            logger.warn(`Rejected an empty webhook message for '${destination}'`);
            return false;
        }
        if (runtime.queue.length >= runtime.config.queueLimit) {
            runtime.queue.shift();
            runtime.dropped++;
        }
        runtime.queue.push({ message });
        runtime.accepted++;
        schedule(runtime);
        return true;
    }

    function destinationStatus(runtime: DestinationRuntime): HmpWebhookDestinationStatus {
        return {
            id: runtime.config.id,
            provider: runtime.config.provider,
            enabled: runtime.config.enabled,
            configured: runtime.configured,
            pending: runtime.queue.length,
            sending: runtime.sending,
            accepted: runtime.accepted,
            delivered: runtime.delivered,
            failed: runtime.failed,
            dropped: runtime.dropped,
            lastStatus: runtime.lastStatus,
            lastError: runtime.lastError,
        };
    }

    function status() {
        return {
            state,
            enabled: config.enabled,
            uptimeMs: now() - startedAt,
            destinations: [...runtimes.values()].map(destinationStatus),
        } as const;
    }

    async function idle(): Promise<void> {
        while (true) {
            const pending = [...runtimes.values()].map((runtime) => runtime.drainPromise).filter((promise): promise is Promise<void> => !!promise);
            if (!pending.length) return;
            await Promise.allSettled(pending);
        }
    }

    function stop(): number {
        if (state === "stopped") return 0;
        state = "stopped";
        let discarded = 0;
        for (const runtime of runtimes.values()) {
            discarded += runtime.queue.length;
            runtime.dropped += runtime.queue.length;
            runtime.queue.length = 0;
            for (const controller of runtime.controllers) controller.abort();
        }
        return discarded;
    }

    return Object.freeze({ send, status, idle, stop });
}

export = { createWebhookService, normalizeMessage };
