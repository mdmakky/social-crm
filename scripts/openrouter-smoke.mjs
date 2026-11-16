#!/usr/bin/env node
/**
 * OpenRouter smoke test. REAL network calls, REAL cost (a few tokens, plus one image call if asked). NEVER run in CI.
 * Usage: OPENROUTER_API_KEY=... [OPENROUTER_MODEL=vendor/model] [OPENROUTER_VISION_MODEL=vendor/model] node scripts/openrouter-smoke.mjs
 * The key is read from the environment and never printed.
 */
const BASE = "https://openrouter.ai/api/v1";
const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error("Set OPENROUTER_API_KEY."); process.exit(2); }
const model = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";
const vision = process.env.OPENROUTER_VISION_MODEL;
const headers = (k = key) => ({ authorization: `Bearer ${k}`, "content-type": "application/json", "X-OpenRouter-Title": "Social CRM smoke" });
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
let failed = 0;
const step = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` (${extra})` : ""}`); if (!ok) failed++; };
const chat = (body, k) => fetch(`${BASE}/chat/completions`, { method: "POST", headers: headers(k), body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });

{
  const r = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(30_000) });
  const j = r.ok ? await r.json() : null;
  step("GET /models", r.ok && Array.isArray(j?.data), `status ${r.status}, ${j?.data?.length ?? 0} models`);
  const m = j?.data?.find((x) => x.id === model);
  if (m) console.log(`  ${model}: pricing ${JSON.stringify(m.pricing)}, input_modalities ${JSON.stringify(m.architecture?.input_modalities)}`);
}
{
  const r = await chat({ model, max_tokens: 5, messages: [{ role: "user", content: "Say hi." }] });
  const j = await r.json().catch(() => null);
  step("5-token completion", r.ok && !j?.error && !!j?.choices?.[0], `status ${r.status}`);
  console.log(`  usage ${JSON.stringify(j?.usage ?? null)}; answered by ${j?.model ?? "?"}; cost ${j?.usage?.cost ?? "not reported"}`);
}
if (vision) {
  const r = await chat({ model: vision, max_tokens: 20, messages: [{ role: "user", content: [{ type: "text", text: "What is this? One word." }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }] }] });
  const j = await r.json().catch(() => null);
  step("vision call", r.ok && !j?.error, `status ${r.status}`);
} else console.log("SKIP vision call (set OPENROUTER_VISION_MODEL)");
{
  const r = await chat({ model, max_tokens: 5, messages: [{ role: "user", content: "hi" }] }, "sk-or-v1-invalid-key-0000");
  step("invalid key is rejected", r.status === 401, `status ${r.status}`);
}
{
  const r = await chat({ model: "nonexistent-vendor/not-a-model", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  const j = await r.json().catch(() => null);
  step("unknown model is an error", !r.ok || !!j?.error, `status ${r.status}, error.code ${j?.error?.code ?? "none"}`);
}
process.exit(failed ? 1 : 0);
