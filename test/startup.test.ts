import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import mistralVibe from "../src/index.ts";
import { createVibeProvider, ID, modelDefinition } from "../src/provider.ts";

function startupHandler() {
  let handler: ((event: SessionStartEvent, ctx: ExtensionContext) => unknown) | undefined;
  mistralVibe({
    registerProvider() {},
    registerCommand() {},
    on(event: string, callback: typeof handler) {
      if (event === "session_start") handler = callback;
    },
  } as unknown as ExtensionAPI);
  assert.ok(handler, "Mistral sessions must initialize their own provider catalog");
  return handler;
}

const event: SessionStartEvent = { type: "session_start", reason: "startup" };

test("cold child startup refreshes its own catalog before DeepSeek inference", async () => {
  const start = startupHandler();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(ID, async () => ({ type: "api_key", key: "child-key" }));
  const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
  const requests: string[] = [];
  const provider = createVibeProvider(async (url, init) => {
    requests.push(url.toString());
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer child-key");
    if (url.toString().endsWith("/models")) {
      return Response.json({ data: [{ id: "deepseek-v4-1-flash-1017", capabilities: { completion_chat: true } }] });
    }
    assert.equal(JSON.parse(init!.body as string).model, "deepseek-v4-1-flash-1017");
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"DEEPSEEK_CHILD_OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
  });
  models.setProvider(provider);
  const model = modelDefinition("deepseek-v4-1-flash-1017");
  // Match pi-subagents: a new provider instance, offline refresh, selected model.
  await models.refresh({ allowNetwork: false });
  const context = { messages: [{ role: "user" as const, content: "Connectivity test", timestamp: 0 }] };
  const before = await models.completeSimple(model, context);
  assert.equal(before.stopReason, "error");
  assert.match(before.errorMessage!, /dedicated-key catalog/);
  assert.equal(requests.length, 0, "cold refusal must not send inference");

  await start(event, { model, modelRegistry: models } as unknown as ExtensionContext);
  assert.equal(requests.length, 1, "startup sends only a catalog GET");
  const after = await models.completeSimple(model, context);
  assert.equal(after.stopReason, "stop");
  assert.deepEqual(after.content, [{ type: "text", text: "DEEPSEEK_CHILD_OK" }]);
  assert.equal(requests.length, 2);
});

test("startup does not refresh Mistral when another provider is selected", async () => {
  const start = startupHandler();
  await start(event, {
    model: { provider: "openai-codex" },
    modelRegistry: { refresh: async () => assert.fail("must not refresh unrelated provider") },
  } as unknown as ExtensionContext);
});

test("startup reports refresh failure or cancellation without enabling models", async () => {
  const start = startupHandler();
  const error = new Error("Mistral request failed (HTTP 401)");
  for (const result of [
    { errors: new Map([[ID, error]]), aborted: false },
    { errors: new Map(), aborted: true },
  ]) {
    await assert.rejects(async () => start(event, {
      model: modelDefinition("deepseek-v4-1-flash-1017"),
      modelRegistry: { refresh: async (options: { providers: string[]; signal: AbortSignal }) => {
        assert.deepEqual(options.providers, [ID]);
        assert.ok(options.signal);
        return result;
      } },
    } as unknown as ExtensionContext), /HTTP 401|cancelled/);
  }
});
