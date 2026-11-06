/** Normalize Mistral's typed content chunks for Pi's OpenAI text-delta adapter. */
export function normalizeDelta(delta: Record<string, unknown>): void {
  if (!Array.isArray(delta.content)) return;
  let text = "";
  let thinking = "";
  const textOf = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) throw new Error("Unsupported Mistral content block");
    return value.map(block => {
      if (block?.type !== "text" || typeof block.text !== "string") throw new Error("Unsupported Mistral content block");
      return block.text;
    }).join("");
  };
  for (const block of delta.content) {
    if (block?.type === "text") text += textOf(block.text);
    else if (block?.type === "thinking") thinking += textOf(block.thinking);
    else throw new Error("Unsupported Mistral streamed content block");
  }
  delta.content = text;
  if (thinking) delta.reasoning_content = (typeof delta.reasoning_content === "string" ? delta.reasoning_content : "") + thinking;
}

export function normalizeMistralStream(response: Response): Response {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
  let pending = "";
  const line = (value: string): string => {
    if (!value.startsWith("data:")) return value;
    const data = value.slice(5).trim();
    if (!data || data === "[DONE]") return value;
    // A malformed JSON event remains visible to the upstream parser.
    let parsed;
    try { parsed = JSON.parse(data); } catch { return value; }
    if (Array.isArray(parsed?.choices)) {
      for (const choice of parsed.choices) {
        if (choice?.delta && typeof choice.delta === "object") normalizeDelta(choice.delta);
      }
    }
    return `data: ${JSON.stringify(parsed)}`;
  };
  const body = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream<string, string>({
    transform(chunk, controller) {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        controller.enqueue(line(pending.slice(0, end).replace(/\r$/, "")) + "\n");
        pending = pending.slice(end + 1);
      }
    },
    flush(controller) { if (pending) controller.enqueue(line(pending)); },
  })).pipeThrough(new TextEncoderStream());
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
