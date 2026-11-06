import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";

export const CONSOLE = "https://console.mistral.ai";
export const BASE = "https://api.mistral.ai/v1";
export const USER_AGENT = "pi-mistral-vibe/0.1.0";
export const BILLING_WARNING = "Model visibility does not guarantee Vibe quota or subscription coverage. Mistral recommends PAYG for API automation. Check your plan and terms before inference.";

export function consoleUrl(value: unknown): string {
  if (typeof value !== "string" || /[\s\\]/u.test(value)) throw new Error("Unsafe Mistral sign-in URL");
  const url = new URL(value);
  if (url.origin !== CONSOLE || url.username || url.password || url.hash) throw new Error("Unsafe Mistral sign-in URL");
  return url.href;
}

export async function jsonRequest(url: string, init: RequestInit, fetcher = globalThis.fetch): Promise<Record<string, unknown>> {
  init.signal?.throwIfAborted();
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init, redirect: "error",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...init.headers },
    });
  } catch {
    if (init.signal?.aborted) throw init.signal.reason;
    throw new Error("Mistral request failed (transport, timeout, or redirect)");
  }
  if (!response.ok) throw new Error(`Mistral request failed (HTTP ${response.status})`);
  try {
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch { throw new Error("Invalid Mistral JSON response"); }
}

export async function browserLogin(interaction: ProviderAuthInteraction, fetcher = globalThis.fetch): Promise<string> {
  const signal = AbortSignal.any([interaction.signal, AbortSignal.timeout(300_000)]);
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const post = (url: string, body: unknown, requestSignal = signal) => jsonRequest(url, {
    method: "POST", signal: AbortSignal.any([requestSignal, AbortSignal.timeout(15_000)]),
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }, fetcher);
  const process = await post(`${CONSOLE}/api/vibe/sign-in`, {
    code_challenge: challenge, code_challenge_method: "S256",
  });
  const signInUrl = consoleUrl(process.sign_in_url);
  const pollUrl = consoleUrl(process.poll_url);
  if (typeof process.process_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(process.process_id)) {
    throw new Error("Invalid Mistral sign-in process identifier");
  }
  const expiry = typeof process.expires_at === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(process.expires_at)
    ? Date.parse(process.expires_at) : NaN;
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error("Mistral sign-in expired or missing expiry");
  const deadline = Math.min(expiry, Date.now() + 300_000);
  const pollSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
  interaction.notify({ type: "info", message: BILLING_WARNING });
  interaction.notify({ type: "auth_url", url: signInUrl, instructions: "Open this URL in a browser (on any machine). Do not share this temporary URL. Waiting for Mistral sign-in…" });
  while (Date.now() < deadline) {
    pollSignal.throwIfAborted();
    const result = await jsonRequest(pollUrl, { signal: AbortSignal.any([pollSignal, AbortSignal.timeout(15_000)]) }, fetcher);
    if (result.status === "completed") {
      if (Date.now() >= deadline) break;
      if (typeof result.exchange_token !== "string" || !result.exchange_token) throw new Error("Missing Mistral exchange token");
      const exchanged = await post(`${CONSOLE}/api/vibe/sign-in/${process.process_id}/exchange`, {
        exchange_token: result.exchange_token, code_verifier: verifier,
      }, pollSignal);
      if (typeof exchanged.api_key !== "string" || !exchanged.api_key.trim()) throw new Error("Missing Mistral API key");
      pollSignal.throwIfAborted();
      return exchanged.api_key.trim();
    }
    if (result.status !== "pending") throw new Error("Mistral sign-in denied or cancelled");
    await delay(Math.min(2000, Math.max(1, deadline - Date.now())), undefined, { signal: pollSignal });
  }
  throw new Error("Mistral sign-in expired");
}
