import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { createVibeProvider, modelDefinition, FALLBACK } from "../src/provider.ts";
import { normalizeDelta, normalizeMistralStream } from "../src/transport.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 0 }] });
const frames = [
  { choices: [{ index: 0, delta: { content: [{ type: "thinking", thinking: [{ type: "text", text: "Think 🌍" }] }] } }] },
  { choices: [{ index: 0, delta: { content: [{ type: "text", text: "Hello 🌍" }, { type: "text", text: "!" }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call12345", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } },
];
function response() {
  // Byte-sized chunks deliberately split UTF-8 sequences and SSE frames.
  const bytes = new TextEncoder().encode(": heartbeat\r\n\r\n" + frames.map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n");
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) controller.close();
      else controller.enqueue(bytes.slice(offset, ++offset));
    },
  }), { headers: { "Content-Type": "text/event-stream", "x-test": "kept" } });
}

test("typed Mistral text and thinking stream correctly, including split Unicode and tools", async () => {
  const provider = createVibeProvider(async () => response());
  const stream = provider.streamSimple(modelDefinition(FALLBACK), context, { apiKey: "test" });
  const events = [];
  for await (const event of stream) events.push(event.type);
  const result = await stream.result();
  assert.equal(result.stopReason, "toolUse");
  assert.ok(result.content.some(b => b.type === "text" && b.text === "Hello 🌍!"));
  assert.ok(result.content.some(b => b.type === "thinking" && b.thinking === "Think 🌍"));
  assert.ok(result.content.some(b => b.type === "toolCall" && b.name === "read"));
  assert.ok(!JSON.stringify(result).includes("[object Object]"));
  assert.equal(result.usage.totalTokens, 30);
  assert.equal(events[0], "start");
  assert.equal(events.at(-1), "done");
});

test("normalization preserves headers, errors, plain text, and fails on unknown content blocks", async () => {
  const normalized = normalizeMistralStream(response());
  assert.equal(normalized.headers.get("x-test"), "kept");
  assert.ok((await normalized.text()).includes("Hello 🌍!"));
  const error = new Response("error", { status: 400 });
  assert.equal(normalizeMistralStream(error), error);
  const plain = { content: "hello", tool_calls: [] };
  normalizeDelta(plain);
  assert.equal(plain.content, "hello");
  assert.throws(() => normalizeDelta({ content: [{ type: "image", image: "unsupported" }] }), /Unsupported/);
});
