# OpenRouter (gateway provider, slices A and B)

Status: implemented with fake fetch and a deterministic mock list. NOT tested against the live service.

## Facts (from OpenRouter docs read 2026-11-17)
- Base URL `https://openrouter.ai/api/v1`; auth `Authorization: Bearer <key>`; optional headers `HTTP-Referer`, `X-OpenRouter-Title`.
- `POST /chat/completions` is OpenAI-compatible. `usage` has `prompt_tokens`, `completion_tokens`, optional `cost` (USD credits) and `is_byok`. The response `model` is the model that answered.
- Errors: body `{error:{code,message,metadata?}}`; HTTP status equals `error.code` for request errors, otherwise HTTP 200 with the error in the body. 400 bad request, 401 invalid credentials, 402 insufficient credits, 403 forbidden (permissions, guardrail, moderation), 408 timeout, 429 rate limited, 502 model down or invalid response, 503 no provider meets routing requirements. `Retry-After` on 429 and 503.
- `GET /models`: `id`, `name`, `context_length`, `pricing` (decimal strings, USD per token; may be negative or sentinel for routers), `supported_parameters`. Images are `image_url` (https URL or base64 data URL).

## UNVERIFIED (never assumed)
- The model list is reachable without a key; the `architecture.input_modalities` field (absent means text only here); that `usage.cost` is present on every response; real 402/403 bodies; `Retry-After` formats seen in practice; vision through the adapter; guardrail error shape; rate limits.

## How it maps
| Provider answer | Our error | Retry |
|---|---|---|
| 401 | `auth` | no |
| 402 | `payment_required` (API 402) | no |
| 403 | `blocked` (API 422), never `auth` | no |
| 408 | `timeout` | yes |
| 429 | `rate_limit` | yes, honours Retry-After (30 s cap) |
| 502, 503 | `provider_error` | yes, honours Retry-After |
| 400 and others | `invalid_request` or `provider_error` | no |
| HTTP 200 with `error` | by `error.code` as above | as above |

Bodies are never copied into errors or logs. Plain `openai` keeps its old mapping (403 is `auth`).

## Config
- Per workspace: Settings > AI > OpenRouter. The key is a password field, sealed per workspace, never shown again. Enable up to 50 models from "Browse models" and pick the default.
- Optional server env: `OPENROUTER_REFERER` (URL), `OPENROUTER_TITLE`. `OPENROUTER_MOCK=1` serves the fixed offline list and a fake adapter (dev and e2e only; refused when `NODE_ENV=production`).
- Cost: `MAX(estimate from the stored price, usage.cost)`, rounded up to a micro-unit; the budget hard stop is unchanged.

## Smoke script (REAL calls, costs money, never in CI)
`OPENROUTER_API_KEY=... [OPENROUTER_MODEL=vendor/model] [OPENROUTER_VISION_MODEL=vendor/model] node scripts/openrouter-smoke.mjs`

It lists models, makes one 5-token completion, prints usage and cost, optionally one vision call, then checks an invalid key and an unknown model. It never prints the key. Record its output here before calling the integration verified.

## Slice B: streaming, native tool calling, structured output
Status: implemented and tested with fake fetch, scripted providers and the offline mock only. NOT tested against the live service. Nothing here was run against a real key.

Facts used (from the OpenRouter docs read earlier):
- Streaming is `stream: true`; the response is SSE `data:` events with `choices[].delta`. The stream may contain comment lines starting with `:` (ignored). The final chunk carries `usage` (and may carry `cost`). A failure after HTTP 200 arrives as an SSE data event with an `error` object.
- Tools use the OpenAI chat format: `tools:[{type:'function',function:{name,description,parameters}}]`, answer `message.tool_calls[{id,type,function:{name,arguments}}]`, `finish_reason` `tool_calls`.
- The model list's `supported_parameters` says which models take `tools` and `structured_outputs`/`response_format`. Slice A already stores that as `supports.tools` / `supports.structuredOutput`.

UNVERIFIED (assumed from OpenAI compatibility, not confirmed against the live service):
- The `data: [DONE]` sentinel (handled when present; the adapter also works without it as long as a finish reason arrived).
- `stream_options: {include_usage: true}` (sent; harmless if ignored; if no usage chunk arrives the tokens are estimated at 4 chars per token and the run is still logged).
- `usage.cost` in the streamed final chunk; the exact shape of a mid-stream `error` event; that `response_format` `json_schema` (non-strict) is honoured by every model that lists `structured_outputs`; that tool-call `arguments` is always a string (a non-string call is dropped); multi-call answers.
- Tool results as `role:'tool'` messages are NOT used: agent runs are a single round (no multi-turn loop), so there is nothing to send back.

How it works:
| Piece | Behaviour |
|---|---|
| Port | `AiProvider.generateStream?(req): AsyncIterable<StreamEvent>` (`delta`, `usage`, `done`, `error`). `GenerateRequest` gained `tools`, `responseFormat`, `signal`; results gained `toolCalls`; `finishReason` gained `tool_calls`. |
| SSE parser | `packages/ai/src/sse.ts`: chunks split anywhere (mid-line, mid-UTF-8), CRLF/CR, `:` comments, multi-line data, no trailing blank line, idle timeout (30 s), line cap, abort. |
| Adapter | Same error table as non-stream for HTTP errors and for mid-stream `{error:{code}}` (402 `payment_required`, 403 `blocked`, 429 `rate_limit`, 502/503 retryable `provider_error`). Hard timeout 120 s for the whole stream, 30 s idle, 64 000 characters of text at most (then `finishReason: length`). A stream that ends without a finish reason is a `provider_error`. |
| `runAiStream` | Shares `begin()` with `runAi`: config, key, prompt, budget hard stop BEFORE the stream starts, run log. Retries only before the first delta; never replays. Cost = max(estimate, reported) from the final usage event. Client abort or a closed iterator aborts the upstream and logs `error` / `client_aborted` with estimated tokens. No transaction is open while streaming; the text is never stored or logged. |
| Fallback | Providers without `generateStream` are called once and sent as one delta. |
| API | `POST .../conversations/:id/ai/suggest-reply/stream` (SSE `delta`, `usage`, `done`, or one `error`). Same permission (`ai.use`) and the SAME rate limit counter as `suggest-reply`. Headers `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`; `: keepalive` comment every 15 s. Always HTTP 200 after the shared checks; failures use the JSON route's codes inside the `error` event. |
| Web proxy | `next.config.ts` rewrites `/v1/*` to the API. Verified in the e2e (production `next start`): the first event arrives about 0.3 s in and the last after 5 s, no `content-encoding`. `no-transform` keeps Next's compression from buffering it. No proxy change was needed. |
| Gates | `supportsTools` / `supportsStructuredOutput` read only the stored flags; unknown model or no flags is `false`. |
| Agents | If the model supports tools and the agent has granted tools: tool definitions are generated from the registry (zod to JSON schema, wire names `crm.add_note` to `crm__add_note`), the system prompt omits the JSON protocol, and `tool_calls` go through the SAME validation (`planAction`: registry, grant, args schema, max 3, approval, sensitive, dry run) and the SAME apply path. Else, if the model supports structured output, the JSON envelope is requested with `response_format` json_schema. Else the prompt-only JSON-in-text protocol is unchanged. Malformed `arguments` JSON is `invalid_args`; no tool calls at all means the text is the draft (or a JSON envelope if the model sent one). |

Smoke script: `scripts/openrouter-smoke.mjs` has opt-in `OPENROUTER_STREAM=1`, `OPENROUTER_TOOLS_MODEL`, `OPENROUTER_STRUCTURED_MODEL` checks that print what the live service really does. NOT run.
