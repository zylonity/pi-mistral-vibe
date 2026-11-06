/** In-memory, payload-free metadata. Never retain URLs, headers, credentials or prompts. */
export interface RequestDiagnostics {
  startedAt: string;
  model: string;
  timeoutMs?: number;
  requestBytes?: number;
  elapsedMs?: number;
  status?: number;
  phase: "awaiting-headers" | "streaming" | "transport-error";
  callerAborted?: boolean;
  transportErrors?: { name?: string; code?: string }[];
}
let last: RequestDiagnostics | undefined;
export function getRequestDiagnostics(): RequestDiagnostics | undefined {
  return last ? structuredClone(last) : undefined;
}
export function startRequestDiagnostics(model: string, timeoutMs: number | undefined, requestBytes?: number): RequestDiagnostics {
  last = { startedAt: new Date().toISOString(), model, timeoutMs, requestBytes, phase: "awaiting-headers" };
  return last;
}
export function recordTransportError(record: RequestDiagnostics, error: unknown, elapsedMs: number, aborted: boolean): void {
  record.phase = "transport-error";
  record.elapsedMs = elapsedMs;
  record.callerAborted = aborted;
  record.transportErrors = [];
  const visited = new Set<unknown>();
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object" || visited.has(value) || record.transportErrors!.length >= 8) return;
    visited.add(value);
    const e = value as { name?: unknown; code?: unknown; cause?: unknown; errors?: unknown };
    const safe = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_]{1,64}$/.test(v) ? v : undefined;
    record.transportErrors!.push({ name: safe(e.name), code: safe(e.code) });
    walk(e.cause);
    if (Array.isArray(e.errors)) e.errors.forEach(walk);
  };
  walk(error);
}
