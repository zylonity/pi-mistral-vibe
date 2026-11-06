import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createVibeProvider, FALLBACK, modelDefinition } from "../src/provider.ts";

test("thinking from a previous response can be replayed without forbidden Mistral fields", async () => {
  const requests: Record<string, any>[] = [];
  const provider = createVibeProvider(async (_url, init) => {
    requests.push(JSON.parse(init!.body as string));
    const frame = { choices: [{ index: 0, delta: {
      content: [{ type: "thinking", thinking: [{ type: "text", text: "Private reasoning" }] }, { type: "text", text: "Hello" }],
    }, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  });
  const user = { role: "user" as const, content: "Hi", timestamp: 0 };
  const model = modelDefinition(FALLBACK);
  const first = await provider.streamSimple(model, normalizeContext({ messages: [user] }), { apiKey: "test" }).result();
  assert.ok(first.content.some(block => block.type === "thinking"));
  const second = await provider.streamSimple(model, normalizeContext({ messages: [user, first, { ...user, content: "Continue" }] }), { apiKey: "test" }).result();
  assert.equal(second.stopReason, "stop");
  const replayed = requests[1].messages.find((message: any) => message.role === "assistant");
  assert.equal(replayed.content, "Hello");
  for (const field of ["reasoning_content", "reasoning_text", "reasoning", "reasoning_details"]) assert.equal(replayed[field], undefined);
});

test("replay cleanup preserves tool calls and does not mutate the hook payload", async () => {
  const original = { role: "assistant", content: "Working", reasoning_content: "private", tool_calls: [{ id: "call12345", type: "function", function: { name: "read", arguments: "{}" } }] };
  let sent: any;
  const provider = createVibeProvider(async (_url, init) => {
    sent = JSON.parse(init!.body as string);
    return new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
  });
  await provider.streamSimple(modelDefinition(FALLBACK), normalizeContext({ messages: [] }), {
    apiKey: "test", onPayload: payload => ({ ...(payload as object), messages: [original] }),
  }).result();
  assert.equal(original.reasoning_content, "private");
  assert.deepEqual(sent.messages[0].tool_calls, original.tool_calls);
  assert.equal(sent.messages[0].content, "Working");
  assert.equal(sent.messages[0].reasoning_content, undefined);
});
