import assert from "node:assert/strict";
import { test } from "node:test";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createVibeProvider, ID } from "../src/provider.ts";

test("native runtime login, refresh, inference, and logout work together", async () => {
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
  const requests: string[] = [];
  models.setProvider(createVibeProvider(async (url, init) => {
    requests.push(url.toString());
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer integration-key");
    if (url.toString().endsWith("/models")) return Response.json({ data: [{ id: "chat", capabilities: { completion_chat: true } }] });
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"works"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
  }));
  let prompts = 0;
  await models.login(ID, "api_key", { prompt: async () => ++prompts === 1 ? "key" : "integration-key", notify: () => {} });
  assert.equal((await credentials.read(ID))?.type, "api_key");
  const refreshed = await models.refresh({ providers: [ID], force: true });
  assert.equal(refreshed.errors.size, 0);
  assert.ok((await models.getAvailable(ID)).some(m => m.id === "chat"));
  assert.ok((await models.getAllAvailable(ID)).some(m => m.id === "chat"));
  const result = await models.completeSimple(models.getModel(ID, "chat")!, { messages: [{ role: "user", content: "Hello", timestamp: 0 }] });
  assert.equal(result.stopReason, "stop");
  assert.equal(result.content[0].type, "text");
  assert.equal(requests.length, 2);
  await models.logout(ID);
  assert.equal(await credentials.read(ID), undefined);
  assert.equal((await models.getAvailable(ID)).length, 0);
});
