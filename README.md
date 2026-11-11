# Mistral Vibe for Pi

Unofficial community provider extension for [Pi](https://pi.dev), inspired by
[nebneo/hermes-mistral-vibe](https://github.com/nebneo/hermes-mistral-vibe).
It connects Pi directly to Mistral's Chat Completions API. Pi keeps its own
agent loop, tools, sessions, streaming UI, and token accounting.

> **Billing warning:** An account-visible model is **not** proof that inference
> is covered by a Vibe subscription or quota. Mistral recommends PAYG for API
> automation. Review your plan, limits, and terms before sending prompts.
> This extension does not probe coverage by making inference requests.

## Requirements

- Pi **1.5.0 or newer**, with native provider registration/authentication APIs.
- Node.js 22 or newer.
- Mistral account access, or a dedicated Mistral Vibe API key.

## Install

From a local checkout:

```sh
cd /path/to/mistral-vibe-pi
pi install .
```

Or, from this directory, try it for one invocation without installing:

```sh
pi -e .
```

There are no third-party runtime dependencies; Pi supplies its own packages.
Restart Pi or use `/reload` after installation. Installing this extension never
changes your selected model or default provider.

## Sign in

In Pi:

```text
/login mistral-vibe
```

Choose either:

- **Sign in with Mistral in a browser** — PKCE sign-in, followed by polling and
  exchange for a dedicated API key. Pi displays the temporary URL, which you can
  open in a browser on another machine if running headlessly. Do not share it.
- **Enter a dedicated API key** — Pi's secret-entry prompt.

Both methods return a native `api_key` credential. Pi stores it in its normal
`auth.json` (normally `~/.pi/agent/auth.json`, or the configured agent directory).
This is local credential storage, **not a promise of encryption**. There is no
refresh token; sign in again if the key expires or is revoked.

Alternatively, set a dedicated environment variable before launching Pi:

```sh
export MISTRAL_VIBE_API_KEY='your-dedicated-key'
pi -e .
```

`MISTRAL_VIBE_API_KEY` takes precedence over the stored key. This extension never
reads `MISTRAL_API_KEY` and does not override Pi's built-in `mistral` provider.

## Select a model

After login, refresh the account-visible chat catalog and deliberately select a
model:

```text
/mistral-vibe-refresh
/model
```

Search for provider **mistral-vibe**. The fallback catalog entry is
`mistral-vibe-cli-latest`; availability is still subject to your account's access.
Pi may also discover the catalog during its normal provider refresh.

The refresh command only calls `GET https://api.mistral.ai/v1/models`; it never
sends a prompt. Only entries with `capabilities.completion_chat === true` are
included. Discovery is cached in memory for one hour per provider instance and
key fingerprint; the refresh command bypasses that TTL. Sessions starting on a
Mistral Vibe model also refresh their own catalog before inference. This includes
subagents: refreshing the parent alone cannot initialize a child's fresh provider.
Startup performs only a bounded catalog GET, never an inference probe. Catalog snapshots are
not written to disk. On same-key refresh failure, the previous in-memory list
remains; a different key cannot use the previous key's discovered models.

### Reasoning

For the reference integration's known GLM relay IDs (`zai-glm-5`,
`zai-glm-5-2`, `zai-glm-5-3`, `zai-glm-latest`, optionally with a numeric `-Nk`
suffix), Pi's thinking level maps to a top-level `reasoning_effort`:

| Pi level | GLM 5 / 5.3 / latest | GLM 5.2 |
|---|---|---|
| low | low | low |
| medium | low | medium |
| high | high | high |
| xhigh / max | max | max |

Off/minimal omit the field; omission does **not** promise to disable the relay's
own reasoning. Unknown model versions keep the server default. The GLM mappings
come from the reference plugin and have not been live-verified by this project.

**DeepSeek** (`deepseek-v4-1-flash-1017` only) was live-verified on
2026-11-06: the relay accepts `none`, `low`, `high`, `xhigh`, and `max` (error
code 3051 rejects `minimal` and `medium`). Pi's levels map as follows:

| Pi level | DeepSeek wire value |
|---|---|
| off (or no reasoning option) | none |
| minimal / low / medium | low |
| high | high |
| xhigh | xhigh |
| max | max |

The provider explicitly declares `xhigh` and `max` in `thinkingLevelMap`, as
required for Pi to expose those levels in its picker. Minimal/medium clamp to
low instead of sending rejected values or silently enabling a higher default.
The payload hook sends `none` even when Pi's API adapter omits its own off field.
Other DeepSeek versions do not inherit unverified mappings.

## Limits and security

- Browser/poll URLs must stay on `https://console.mistral.ai`; API calls use
  `https://api.mistral.ai/v1`. Redirects are rejected. Endpoint overrides and
  payload model substitutions are blocked.
- Inference is restricted to the fallback entry or the dedicated key's current
  discovered catalog. There is no silent model substitution.
- Pi's existing Chat Completions implementation handles messages, tools, images,
  streaming events, usage, cross-provider message conversion, and cancellation.
  A streaming transport shim converts Mistral typed text/thinking content blocks
  into OpenAI text/reasoning deltas, preventing `[object Object]` output. It
  preserves split UTF-8 characters, tool calls, finish reasons, and usage.
  SDK/provider-internal retries are disabled here; **Pi's agent-level retries
  can still run**.
- Pricing metadata is unknown and recorded as zero. **Pi's displayed cost is
  not a billing estimate and zero does not mean free.** Token usage is taken
  from the API response.
- Context limits use `max_context_length` when present, otherwise a conservative
  128,000-token placeholder. The output cap defaults to 8,192 (bounded by the
  context limit). These defaults may need adjustment as Mistral changes models.
- Image input is advertised only when the catalog explicitly reports vision.
- This is trusted extension code running inside Pi, not a security sandbox.
  Other installed extensions can inspect prompts/credentials and alter requests.
  HTTP uses Node's fetch and its configured transport; this plugin does not
  guarantee that a globally configured proxy/dispatcher is bypassed.
- Mistral's sign-in endpoints, access policies, and model metadata may change.
  This project is not affiliated with Mistral AI, Pi, or Hermes.

## Logout / uninstall

```text
/logout
```

Choose `mistral-vibe`, then unset `MISTRAL_VIBE_API_KEY` separately if you used it.
Local logout does not revoke a remote key; revoke it through Mistral if needed.

To remove the local package, use the same source you installed:

```sh
pi list
pi remove /absolute/path/to/mistral-vibe-pi
```

## Development and tests

```sh
npm install
npm run typecheck
npm test
```

Tests use injected HTTP fixtures; no account, real credentials, or inference is
needed. They cover PKCE exchange, sign-in URL validation, expiry/denial/abort,
secret-safe authentication errors, native API-key storage semantics, catalog
filtering/cache/key rotation, text/Unicode/empty streams, tool calls, usage,
request hooks, request guards, HTTP errors, and cancellation.

Live authentication and inference are intentionally **not** part of automated
tests. Before relying on this provider, manually verify browser login and run a
small text/tool session only after checking billing and account access.

## Layout

- `src/index.ts` — Pi extension registration and refresh command
- `src/auth.ts` — PKCE browser authentication and bounded JSON requests
- `src/provider.ts` — native provider, catalog, reasoning mapping, guarded transport
- `src/transport.ts` — streamed Mistral typed-content normalization
- `test/` — offline authentication and provider tests

MIT licensed. Authentication protocol and reasoning mappings adapted from the
Hermes Mistral Vibe reference implementation; see `LICENSE`.
