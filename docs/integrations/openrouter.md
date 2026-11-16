# OpenRouter (gateway provider, slice A)

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
