import { createHash } from "node:crypto";
import {
  createProvider,
  type Api, type Model, type Provider, type Credential, type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { BASE, BILLING_WARNING, browserLogin, jsonRequest, USER_AGENT } from "./auth.ts";
import { normalizeMistralStream } from "./transport.ts";
import { startRequestDiagnostics, recordTransportError } from "./diagnostics.ts";

export const ID = "mistral-vibe";
export const FALLBACK = "mistral-vibe-cli-latest";
const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex");

// Live-verified 2026-11-06 against api.mistral.ai/v1/chat/completions:
// deepseek-v4-1-flash-1017 accepts none/low/high/xhigh/max (code 3051 rejects minimal/medium).
const DEEPSEEK_EFFORTS = new Set(["none", "low", "high", "xhigh", "max"]);

export function reasoningEffort(id: string, level?: string): string | undefined {
  // Deliberately exact: future versions must not inherit unverified wire fields.
  if (id === "deepseek-v4-1-flash-1017") {
    if (!level || level === "off") return "none";
    if (level === "minimal" || level === "medium") return "low";
    return DEEPSEEK_EFFORTS.has(level) ? level : undefined;
  }
  if (!/^(?:zai-glm-5(?:-2|-3)?|zai-glm-latest)(?:-\d+k)?$/.test(id)) return undefined;
  if (!level || level === "off" || level === "minimal") return undefined;
  if (level === "xhigh" || level === "max") return "max";
  if (level === "medium" && !/^zai-glm-5-2(?:-|$)/.test(id)) return "low";
  return ["low", "medium", "high"].includes(level) ? level : undefined;
}

export function modelDefinition(id: string, row: Record<string, unknown> = {}): Model<"openai-completions"> {
  const capabilities = row.capabilities as Record<string, unknown> | undefined;
  const contextWindow = typeof row.max_context_length === "number" && Number.isSafeInteger(row.max_context_length) && row.max_context_length > 0
    ? row.max_context_length : 128_000;
  return {
    id, name: typeof row.name === "string" && row.name ? row.name : id,
    provider: ID, api: "openai-completions", baseUrl: BASE,
    reasoning: reasoningEffort(id, "low") !== undefined,
    // Pi hides extended levels unless these entries are explicitly declared.
    thinkingLevelMap: reasoningEffort(id, "low") !== undefined ? {
      xhigh: reasoningEffort(id, "xhigh")!, max: reasoningEffort(id, "max")!,
      ...(id === "deepseek-v4-1-flash-1017" ? { off: "none", minimal: "low", medium: "low" } : {}),
    } : undefined,
    input: capabilities?.vision === true ? ["text", "image"] : ["text"],
    // Unknown prices, NOT a claim of free usage.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow, maxTokens: Math.min(contextWindow, 8192),
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
  };
}

export function parseCatalog(payload: Record<string, unknown>): Model<"openai-completions">[] {
  if (!Array.isArray(payload.data)) throw new Error("Invalid Mistral model catalog");
  const models = new Map<string, Model<"openai-completions">>();
  for (const row of payload.data) {
    if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id.trim() || row.id !== row.id.trim()) {
      throw new Error("Invalid Mistral catalog entry");
    }
    if (row.capabilities?.completion_chat === true) models.set(row.id, modelDefinition(row.id, row));
  }
  return [...models.values()];
}

export function createVibeProvider(fetcher = globalThis.fetch): Provider<"openai-completions"> {
  let catalog = [modelDefinition(FALLBACK)];
  let scope: string | undefined;
  let refreshedAt = 0;
  const keyFor = (credential?: Credential) => process.env.MISTRAL_VIBE_API_KEY?.trim() || (credential?.type === "api_key" ? credential.key?.trim() : undefined);
  const api = openAICompletionsApi();
  // Keep Pi's streaming, tools, instrumentation, cancellation and usage accounting.
  // Restrict the final HTTP destination too, after model/auth overrides.
  const guardedOptions = (model: Model<"openai-completions">, options: SimpleStreamOptions & { reasoningEffort?: string } = {}) => {
    const key = options.apiKey;
    const allowed = model.id === FALLBACK || (key && scope === fingerprint(key) && catalog.some(m => m.id === model.id));
    if (!key) throw new Error("Missing Mistral Vibe key. Run /login mistral-vibe or set MISTRAL_VIBE_API_KEY.");
    if (!allowed) throw new Error("Model is not in the current dedicated-key catalog. Refresh models first.");
    if (model.baseUrl.replace(/\/$/, "") !== BASE) throw new Error("Mistral Vibe requires its fixed API endpoint");
    return {
      ...options, maxRetries: 0,
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.href !== `${BASE}/chat/completions`) throw new Error("Mistral Vibe request destination blocked");
        const started = Date.now();
        const diagnostics = startRequestDiagnostics(model.id, options.timeoutMs,
          typeof init?.body === "string" ? Buffer.byteLength(init.body) : undefined);
        try {
          const response = await fetcher(input, { ...init, redirect: "error" });
          diagnostics.elapsedMs = Date.now() - started;
          diagnostics.status = response.status;
          diagnostics.phase = "streaming";
          return normalizeMistralStream(response);
        } catch (error) {
          recordTransportError(diagnostics, error, Date.now() - started, init?.signal?.aborted ?? false);
          throw error;
        }
      },
      onPayload: async (payload: unknown, currentModel: Model<Api>) => {
        const replacement = await options.onPayload?.(payload, currentModel);
        const body = { ...((replacement ?? payload) as Record<string, unknown>) };
        if (body.model !== model.id) throw new Error("Mistral Vibe model substitution blocked");
        // Pi replays streamed thinking using OpenAI-compatible vendor fields.
        // Mistral's strict assistant-message schema rejects reasoning_content (422).
        // Keep reasoning visible locally, but do not replay these vendor fields.
        if (Array.isArray(body.messages)) {
          body.messages = body.messages.map(message => {
            if (!message || typeof message !== "object" || message.role !== "assistant") return message;
            const clean = { ...message };
            for (const field of ["reasoning_content", "reasoning_text", "reasoning", "reasoning_details"]) delete clean[field];
            return clean;
          });
        }
        delete body.reasoning_effort;
        const effort = reasoningEffort(model.id, options.reasoning ?? options.reasoningEffort);
        if (effort) body.reasoning_effort = effort;
        return body;
      },
    };
  };
  const provider = createProvider<"openai-completions">({
    id: ID, name: "Mistral Vibe (unofficial)", baseUrl: BASE,
    headers: { "User-Agent": USER_AGENT }, models: [],
    auth: {
      apiKey: {
        name: "Mistral Vibe",
        async login(interaction) {
          interaction.notify({ type: "info", message: BILLING_WARNING });
          const method = await interaction.prompt({ type: "select", message: "Mistral Vibe authentication", options: [
            { id: "browser", label: "Sign in with Mistral in a browser" },
            { id: "key", label: "Enter a dedicated API key" },
          ] });
          const key = method === "browser" ? await browserLogin(interaction, fetcher)
            : method === "key" ? (await interaction.prompt({ type: "secret", message: "Mistral Vibe API key" })).trim() : "";
          interaction.signal.throwIfAborted();
          if (!key) throw new Error("No Mistral Vibe API key supplied");
          return { type: "api_key", key };
        },
        async resolve({ credential, ctx, signal }) {
          signal.throwIfAborted();
          const env = (await ctx.env("MISTRAL_VIBE_API_KEY"))?.trim();
          const key = env || credential?.key?.trim();
          return key ? { auth: { apiKey: key }, source: env ? "MISTRAL_VIBE_API_KEY" : "stored Mistral Vibe key" } : undefined;
        },
      },
    },
    api: {
      ...api,
      stream: (model, context, options) => api.stream(model, context, guardedOptions(model as Model<"openai-completions">, options)),
      streamSimple: (model, context, options) => api.streamSimple(model, context, guardedOptions(model as Model<"openai-completions">, options)),
    },
  });
  return {
    ...provider,
    getModels: () => catalog,
    getAllModels: () => catalog,
    filterModels: (models, credential) => {
      const key = keyFor(credential);
      return key && scope === fingerprint(key) ? models : models.filter(m => m.id === FALLBACK);
    },
    async refreshModels(context) {
      const key = keyFor(context.credential);
      const nextScope = key ? fingerprint(key) : undefined;
      if (scope !== nextScope) {
        await context.publish({ update: () => { catalog = [modelDefinition(FALLBACK)]; scope = nextScope; refreshedAt = 0; } });
      }
      if (!context.allowNetwork || !key) return;
      if (context.baseUrl && context.baseUrl.replace(/\/$/, "") !== BASE) throw new Error("Mistral Vibe catalog endpoint override blocked");
      if (!context.force && refreshedAt && Date.now() - refreshedAt < 3_600_000) return;
      const payload = await jsonRequest(`${BASE}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(8000)]),
      }, fetcher);
      const discovered = parseCatalog(payload);
      if (!discovered.some(m => m.id === FALLBACK)) discovered.unshift(modelDefinition(FALLBACK));
      await context.publish({ update: () => { catalog = discovered; scope = nextScope; refreshedAt = Date.now(); } });
    },
  };
}
