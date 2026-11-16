#!/usr/bin/env node
/**
 * OpenRouter smoke test. REAL network calls, REAL cost (a few tokens, plus one image call if asked). NEVER run in CI.
 * Usage: OPENROUTER_API_KEY=... [OPENROUTER_MODEL=vendor/model] [OPENROUTER_VISION_MODEL=vendor/model] node scripts/openrouter-smoke.mjs
 * Slice B extras (opt-in): OPENROUTER_STREAM=1, OPENROUTER_TOOLS_MODEL, OPENROUTER_STRUCTURED_MODEL.
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
// Slice B, opt-in (more real calls, a few tokens each): OPENROUTER_STREAM=1, OPENROUTER_TOOLS_MODEL=vendor/model (must support tools), OPENROUTER_STRUCTURED_MODEL=vendor/model (must support structured_outputs).
// These record what the live service really does with the UNVERIFIED parts: SSE comment lines, [DONE], usage on the final chunk, mid-stream errors, tool_calls shape, response_format json_schema.
if (process.env.OPENROUTER_STREAM === "1") {
  const r = await chat({ model, max_tokens: 20, stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "Count from 1 to 5." }] });
  const ct = r.headers.get("content-type") ?? "";
  let raw = "";
  if (r.ok && r.body) { const dec = new TextDecoder(); for await (const c of r.body) raw += dec.decode(c, { stream: true }); }
  const lines = raw.split(/\r?\n/);
  const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  const parsed = data.filter((d) => d !== "[DONE]").flatMap((d) => { try { return [JSON.parse(d)]; } catch { return []; } });
  const withUsage = parsed.filter((p) => p.usage);
  step("stream: HTTP 200 text/event-stream", r.ok && ct.includes("text/event-stream"), `status ${r.status}, ${ct}`);
  step("stream: delta chunks", parsed.some((p) => typeof p.choices?.[0]?.delta?.content === "string"), `${parsed.length} chunks`);
  step("stream: final usage chunk", withUsage.length > 0, `usage ${JSON.stringify(withUsage.at(-1)?.usage ?? null)}`);
  console.log(`  [DONE] sentinel seen: ${data.includes("[DONE]")}; comment lines seen: ${lines.filter((l) => l.startsWith(":")).length}; mid-stream error events: ${parsed.filter((p) => p.error).length}`);
} else console.log("SKIP streaming (set OPENROUTER_STREAM=1)");
if (process.env.OPENROUTER_TOOLS_MODEL) {
  const tools = [{ type: "function", function: { name: "crm__add_note", description: "Add an internal note.", parameters: { type: "object", properties: { body: { type: "string" } }, required: ["body"], additionalProperties: false } } }];
  const r = await chat({ model: process.env.OPENROUTER_TOOLS_MODEL, max_tokens: 80, tools, messages: [{ role: "user", content: "Add a note saying: call back Friday. Use the tool." }] });
  const j = await r.json().catch(() => null);
  const call = j?.choices?.[0]?.message?.tool_calls?.[0];
  step("tool call", r.ok && !j?.error && call?.function?.name === "crm__add_note", `status ${r.status}, finish_reason ${j?.choices?.[0]?.finish_reason}`);
  console.log(`  tool_calls shape: id ${typeof call?.id}, type ${call?.type}, arguments is ${typeof call?.function?.arguments}`);
} else console.log("SKIP tool call (set OPENROUTER_TOOLS_MODEL)");
if (process.env.OPENROUTER_STRUCTURED_MODEL) {
  const schema = { type: "object", properties: { reply: { type: "string" }, actions: { type: "array", items: { type: "object" } } }, required: ["reply", "actions"] };
  const r = await chat({ model: process.env.OPENROUTER_STRUCTURED_MODEL, max_tokens: 80, response_format: { type: "json_schema", json_schema: { name: "agent_reply", schema } }, messages: [{ role: "user", content: "Reply with a greeting and no actions." }] });
  const j = await r.json().catch(() => null);
  let ok = false; try { const o = JSON.parse(j?.choices?.[0]?.message?.content ?? ""); ok = typeof o.reply === "string" && Array.isArray(o.actions); } catch { /* not JSON */ }
  step("structured output (json_schema)", r.ok && !j?.error && ok, `status ${r.status}`);
} else console.log("SKIP structured output (set OPENROUTER_STRUCTURED_MODEL)");
process.exit(failed ? 1 : 0);
