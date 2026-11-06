import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { AuthEvent, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { browserLogin, CONSOLE, consoleUrl, jsonRequest } from "../src/auth.ts";
import { createVibeProvider } from "../src/provider.ts";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const processData = () => ({
  process_id: "process_123", sign_in_url: `${CONSOLE}/vibe/login?secret=temporary`,
  poll_url: `${CONSOLE}/api/vibe/sign-in/process_123`, expires_at: new Date(Date.now() + 60_000).toISOString(),
});
const interaction = (events: AuthEvent[] = []): ProviderAuthInteraction => ({
  signal: new AbortController().signal, prompt: async () => { throw new Error("Unexpected prompt"); }, notify: e => events.push(e),
});

test("rejects foreign, credentialed, fragmented and ambiguous sign-in URLs", () => {
  for (const url of ["http://console.mistral.ai/login", "https://console.mistral.ai.evil.test/", "https://user@console.mistral.ai/", `${CONSOLE}/#fragment`, `${CONSOLE}/\\evil`, `${CONSOLE}/a\nb`]) {
    assert.throws(() => consoleUrl(url));
  }
  assert.equal(consoleUrl(`${CONSOLE}/login?code=x`), `${CONSOLE}/login?code=x`);
});

test("browser sign-in exchanges PKCE verifier for key without leaking it in notifications", async () => {
  const events: AuthEvent[] = [];
  let challenge = "", calls = 0;
  const key = await browserLogin(interaction(events), async (url, init) => {
    calls++;
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    if (calls === 1) {
      assert.equal(url, `${CONSOLE}/api/vibe/sign-in`);
      const body = JSON.parse(init!.body as string);
      challenge = body.code_challenge;
      assert.equal(body.code_challenge_method, "S256");
      return json(processData());
    }
    if (calls === 2) return json({ status: "completed", exchange_token: "exchange-secret" });
    assert.equal(url, `${CONSOLE}/api/vibe/sign-in/process_123/exchange`);
    const body = JSON.parse(init!.body as string);
    assert.equal(body.exchange_token, "exchange-secret");
    assert.equal(createHash("sha256").update(body.code_verifier).digest("base64url"), challenge);
    return json({ api_key: "private-key" });
  });
  assert.equal(key, "private-key");
  assert.equal(calls, 3);
  assert.ok(events.some(e => e.type === "auth_url"));
  assert.ok(!JSON.stringify(events).includes("private-key"));
  assert.ok(!JSON.stringify(events).includes("exchange-secret"));
});

test("unsafe server URLs are rejected before opening browser or polling", async () => {
  const events: AuthEvent[] = [];
  let calls = 0;
  await assert.rejects(browserLogin(interaction(events), async () => {
    calls++; return json({ ...processData(), poll_url: "https://evil.test/steal" });
  }), /Unsafe/);
  assert.equal(calls, 1);
  assert.equal(events.length, 0);
});

test("expiry, denial, malformed exchange and abort fail safely", async () => {
  await assert.rejects(browserLogin(interaction(), async () => json({ ...processData(), expires_at: "invalid" })), /expiry/);
  let calls = 0;
  await assert.rejects(browserLogin(interaction(), async () => json(++calls === 1 ? processData() : { status: "denied" })), /denied/);
  calls = 0;
  await assert.rejects(browserLogin(interaction(), async () => json(++calls === 1 ? processData() : { status: "completed" })), /exchange token/);
  const controller = new AbortController();
  const i = interaction(); i.signal = controller.signal;
  calls = 0;
  await assert.rejects(browserLogin(i, async () => {
    if (++calls === 1) return json(processData());
    controller.abort(new Error("cancelled"));
    return json({ status: "pending" });
  }), /abort|cancelled/i);
});

test("HTTP and transport errors do not expose response bodies or secrets", async () => {
  await assert.rejects(jsonRequest(`${CONSOLE}/api/vibe/sign-in`, {}, async () => json({ api_key: "secret" }, 403)), error => {
    assert.match(String(error), /HTTP 403/); assert.ok(!String(error).includes("secret")); return true;
  });
  await assert.rejects(jsonRequest(CONSOLE, {}, async () => { throw new Error("secret-url"); }), error => {
    assert.ok(!String(error).includes("secret-url")); return true;
  });
});

test("manual login uses native API-key credential and dedicated env wins", async () => {
  const auth = createVibeProvider().auth.apiKey!;
  let prompts = 0;
  const credential = await auth.login!({ ...interaction(), prompt: async () => ++prompts === 1 ? "key" : " stored-key " });
  assert.deepEqual(credential, { type: "api_key", key: "stored-key" });
  const names: string[] = [];
  const resolved = await auth.resolve({ credential, signal: new AbortController().signal, ctx: {
    env: async name => { names.push(name); return "env-key"; }, fileExists: async () => false,
  } });
  assert.equal(resolved?.auth.apiKey, "env-key");
  assert.deepEqual(names, ["MISTRAL_VIBE_API_KEY"]);
});
