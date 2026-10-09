interface EngineError { code?: unknown; message?: unknown; applyErrors?: Array<{ itemId?: unknown; holder?: unknown; code?: unknown }> }

// The engine rejects with plain { code, message } objects, not Errors, so String() printed
// "[object Object]". A native revision's apply errors name the rows that failed.
function messageOf(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (!error || typeof error !== "object") return String(error);
    const { code, message, applyErrors } = error as EngineError;
    const text = [code, message].filter((part) => typeof part === "string" && part !== "").join(": ");
    if (!text) {
        try { return JSON.stringify(error); }
        catch (_) { return String(error); }
    }
    const rows = Array.isArray(applyErrors) ? applyErrors.map((row) => `${String(row?.itemId)}@${String(row?.holder)} ${String(row?.code)}`) : [];
    return rows.length ? `${text} (${rows.join(", ")})` : text;
}

export = { messageOf };
// TypeScript source.
