import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, getSupportedThinkingLevels, normalizeContext, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { createVibeProvider, FALLBACK, ID, modelDefinition, parseCatalog, reasoningEffort } from "../src/provider.ts";
import { BASE } from "../src/auth.ts";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const refresh = (key = "dedicated", extra: Partial<RefreshModelsContext> = {}): RefreshModelsContext => ({
  credential: { type: "api_key", key }, allowNetwork: true, signal: new AbortController().signal,
  async publish({ update }) { update?.(); return true; }, ...extra,
});
const context = normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 0 }] });
function sse(chunks: unknown[]) {
  return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
}
const textChunks = [
  { choices: [{ index: 0, delta: { role: "assistant", content: "Hi 🌍" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } },
];

test("catalog only includes explicitly chat-capable models, deduplicates, and maps vision", () => {
  const models = parseCatalog({ data: [
    { id: "chat", capabilities: { completion_chat: true, vision: true }, max_context_length: 32000 },
    { id: "chat", capabilities: { completion_chat: true, vision: true }, max_context_length: 32000 },
    { id: "embed", capabilities: { completion_chat: false } },
    { id: "unknown" }, { id: "string", capabilities: { completion_chat: "true" } },
  ] });
  assert.deepEqual(models.map(m => m.id), ["chat"]);
  assert.deepEqual(models[0].input, ["text", "image"]);
  assert.equal(models[0].contextWindow, 32000);
  assert.throws(() => parseCatalog({ data: [{ id: " " }] }));
  assert.throws(() => parseCatalog({}));
});

test("reasoning mapping does not guess future versions or escalate medium", () => {
  assert.equal(reasoningEffort("zai-glm-5-3", "medium"), "low");
  assert.equal(reasoningEffort("zai-glm-5-2", "medium"), "medium");
  assert.equal(reasoningEffort("zai-glm-latest", "xhigh"), "max");
  for (const id of ["zai-glm-5-4", "some-glm-5", FALLBACK]) assert.equal(reasoningEffort(id, "high"), undefined);
  assert.equal(reasoningEffort("zai-glm-5", "off"), undefined);
});

test("DeepSeek mapping uses only relay-verified values and maps off to none", () => {
  const id = "deepseek-v4-1-flash-1017";
  assert.equal(reasoningEffort(id, "off"), "none");
  assert.equal(reasoningEffort(id), "none");
  for (const level of ["low", "high", "xhigh", "max"]) assert.equal(reasoningEffort(id, level), level);
  for (const level of ["minimal", "medium"]) assert.equal(reasoningEffort(id, level), "low");
  assert.equal(reasoningEffort("deepseek-v4-2", "high"), undefined);
  assert.equal(reasoningEffort("deepseek-v4-1-flash-0999", "high"), undefined);
  assert.deepEqual(getSupportedThinkingLevels(modelDefinition(id)), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.ok(getSupportedThinkingLevels(modelDefinition("zai-glm-5-3")).includes("max"));
});

test("DeepSeek effort is emitted on the wire and off sends none", async () => {
  const bodies: Record<string, unknown>[] = [];
  const provider = createVibeProvider(async (url, init) => {
    if (url.toString().endsWith("/models")) {
      return json({ data: [{ id: "deepseek-v4-1-flash-1017", capabilities: { completion_chat: true } }] });
    }
    bodies.push(JSON.parse(init!.body as string));
    return sse(textChunks);
  });
  await provider.refreshModels!(refresh());
  const model = provider.getModels().find(m => m.id === "deepseek-v4-1-flash-1017")!;
  assert.equal(model.reasoning, true);
  for (const level of ["low", "high", "xhigh", "max", "minimal", "medium", undefined] as const) {
    const result = await provider.streamSimple(model, context, { apiKey: "dedicated", reasoning: level }).result();
    assert.equal(result.stopReason, "stop");
  }
  assert.deepEqual(bodies.map(b => b.reasoning_effort), ["low", "high", "xhigh", "max", "low", "low", "none"]);
  // API-specific calls also preserve explicit reasoningEffort.
  await provider.stream(model, context, { apiKey: "dedicated", reasoningEffort: "max" }).result();
  assert.equal(bodies.at(-1)?.reasoning_effort, "max");
});

test("discovery uses dedicated key, TTL, forced refresh and isolated catalog on key rotation", async () => {
  let calls = 0;
  const provider = createVibeProvider(async (url, init) => {
    calls++;
    assert.equal(url, `${BASE}/models`);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer dedicated");
    return json({ data: [{ id: "chat", capabilities: { completion_chat: true } }] });
  });
  assert.deepEqual(provider.getModels().map(m => m.id), [FALLBACK]);
  await provider.refreshModels!(refresh());
  assert.deepEqual(provider.getAllModels!().map(m => m.id), [FALLBACK, "chat"]);
  await provider.refreshModels!(refresh());
  assert.equal(calls, 1);
  await provider.refreshModels!(refresh("dedicated", { force: true }));
  assert.equal(calls, 2);
  await provider.refreshModels!(refresh("different", { allowNetwork: false }));
  assert.deepEqual(provider.getModels().map(m => m.id), [FALLBACK]);
});

test("failed catalog refresh preserves same-key catalog; new key cannot use old models", async () => {
  let fail = false;
  const provider = createVibeProvider(async () => fail ? json({}, 401) : json({ data: [{ id: "chat", capabilities: { completion_chat: true } }] }));
  await provider.refreshModels!(refresh());
  fail = true;
  await assert.rejects(provider.refreshModels!(refresh("dedicated", { force: true })), /HTTP 401/);
  assert.equal(provider.getModels().length, 2);
  assert.deepEqual(provider.filterModels!(provider.getModels(), { type: "api_key", key: "new" }).map(m => m.id), [FALLBACK]);
});

test("native runtime sees discovered catalog, not an empty createProvider baseline", async () => {
  const provider = createVibeProvider(async () => json({ data: [{ id: "chat", capabilities: { completion_chat: true } }] }));
  const models = createModels();
  models.setProvider(provider);
  await provider.refreshModels!(refresh());
  assert.equal(models.getModels(ID).length, 2);
  assert.equal(models.getAllModels(ID).length, 2);
});

test("built-in streaming preserves text, Unicode, usage and request hooks", async () => {
  let payloadSeen = false, responseSeen = false, eventCount = 0;
  const provider = createVibeProvider(async (url, init) => {
    assert.equal(url.toString(), `${BASE}/chat/completions`);
    assert.equal(init?.redirect, "error");
    const body = JSON.parse(init!.body as string);
    assert.equal(body.model, FALLBACK);
    assert.equal(body.max_tokens, 100);
    assert.equal(body.store, undefined);
    assert.equal(body.reasoning_effort, undefined);
    assert.ok(new Headers(init?.headers).get("authorization")?.includes("dedicated"));
    return sse(textChunks);
  });
  const stream = provider.streamSimple(modelDefinition(FALLBACK), context, {
    apiKey: "dedicated", maxTokens: 100,
    onPayload: () => { payloadSeen = true; },
    onResponse: () => { responseSeen = true; },
    onProviderStreamEvent: () => { eventCount++; },
  });
  const events = [];
  for await (const event of stream) events.push(event.type);
  const result = await stream.result();
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(result.content, [{ type: "text", text: "Hi 🌍" }]);
  assert.equal(result.usage.input, 12);
  assert.equal(result.usage.output, 4);
  assert.equal(events[0], "start");
  assert.equal(events.at(-1), "done");
  assert.ok(payloadSeen && responseSeen && eventCount > 0);
});

test("tool calls and empty text are delegated correctly", async () => {
  const provider = createVibeProvider(async () => sse([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call12345", type: "function", function: { name: "read", arguments: '{"path":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ]));
  const result = await provider.streamSimple(modelDefinition(FALLBACK), context, { apiKey: "dedicated" }).result();
  assert.equal(result.stopReason, "toolUse");
  assert.equal(result.content[0].type, "toolCall");
  if (result.content[0].type === "toolCall") assert.deepEqual(result.content[0].arguments, { path: "README.md" });
  const empty = createVibeProvider(async () => sse([{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]));
  assert.equal((await empty.streamSimple(modelDefinition(FALLBACK), context, { apiKey: "dedicated" }).result()).stopReason, "stop");
});

test("blocks unknown models, endpoint overrides, and payload model substitution", async () => {
  const provider = createVibeProvider(async () => { throw new Error("Must not send"); });
  assert.throws(() => provider.streamSimple(modelDefinition("unknown"), context, { apiKey: "dedicated" }), /catalog/);
  assert.throws(() => provider.streamSimple({ ...modelDefinition(FALLBACK), baseUrl: "https://evil.example/v1" }, context, { apiKey: "dedicated" }), /fixed API/);
  const result = await provider.streamSimple(modelDefinition(FALLBACK), context, { apiKey: "dedicated", onPayload: p => ({ ...(p as object), model: "other" }) }).result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage!, /substitution/);
});

test("HTTP errors and cancellation produce terminal errors without retries", async () => {
  let calls = 0;
  const provider = createVibeProvider(async () => { calls++; return json({ error: { message: "context_length_exceeded" } }, 400); });
  const result = await provider.streamSimple(modelDefinition(FALLBACK), context, { apiKey: "dedicated" }).result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage!, /context_length_exceeded/);
  assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  const aborted = await provider.streamSimple(modelDefinition(FALLBACK), context, { apiKey: "dedicated", signal: controller.signal }).result();
  assert.equal(aborted.stopReason, "aborted");
});

test("deepseek output budget leaves room for reasoning", () => {
  assert.equal(modelDefinition("deepseek-v4-1-flash-1017", { max_context_length: 1048576 }).maxTokens, 65536);
  assert.equal(modelDefinition("mistral-vibe-cli-latest").maxTokens, 8192);
});

test("deepseek max_tokens floor holds even for a fallback-cloned model (async subagent children)", async () => {
  const bodies: Record<string, unknown>[] = [];
  const provider = createVibeProvider(async (url, init) => {
    if (url.toString().endsWith("/models")) {
      return json({ data: [{ id: "deepseek-v4-1-flash-1017", capabilities: { completion_chat: true } }] });
    }
    bodies.push(JSON.parse(init!.body as string));
    return sse(textChunks);
  });
  await provider.refreshModels!(refresh());
  // Offline child refresh clones the fallback definition under the real id: maxTokens 8192.
  const cloned = { ...modelDefinition(FALLBACK), id: "deepseek-v4-1-flash-1017", name: "deepseek-v4-1-flash-1017" };
  assert.equal(cloned.maxTokens, 8192);
  await provider.streamSimple(cloned, context, { apiKey: "dedicated", reasoning: "high" }).result();
  await provider.streamSimple(cloned, context, { apiKey: "dedicated", maxTokens: 100 }).result();
  assert.deepEqual(bodies.map(b => b.max_tokens), [65536, 65536]);
  // Other models keep the caller's budget.
  await provider.streamSimple(modelDefinition(FALLBACK), context, { apiKey: "dedicated", maxTokens: 100 }).result();
  assert.equal(bodies.at(-1)?.max_tokens, 100);
});
