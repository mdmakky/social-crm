import { estimateAudioSeconds, estimateMediaTokens } from "../media.ts";
import { fingerprintBytes } from "../logging.ts";
import { AiError, type AiErrorCode, type AiProvider, type GenerateRequest, type GenerateResult, type MediaRequest, type StreamEvent } from "../types.ts";

const est = (s: string) => Math.max(1, Math.ceil(s.length / 4));

/** Stable one-line identity of a media input: depends only on mime, size and content hash. */
const tag = (m: MediaRequest["media"]) => `${m.mime}, ${m.bytes.byteLength} bytes, hash ${fingerprintBytes(m.bytes).slice(0, 8)}`;

/** Deterministic, offline, free. Output depends only on the last user message, so tests and the demo are repeatable. Every draft says it is a mock. */
export function createMockProvider(): AiProvider {
  const mediaResult = (r: MediaRequest, text: string) => ({ text, usage: { inputTokens: estimateMediaTokens(r.media.kind, r.media.bytes.byteLength) + est(r.prompt), outputTokens: est(text) }, finishReason: "stop" as const });
  /**
   * Test hooks, all in the last user message (so offline flows stay deterministic):
   * `[[MOCK_REPLY:text]]` exact answer; `[[MOCK_TOOL:<wire_tool_name>:<json args>]]` a native tool call when that tool was offered; `[[MOCK_ERROR:blocked|payment_required]]` a typed failure;
   * `[[MOCK_SLOW]]` makes a stream pause between chunks (so a Stop click can land).
   */
  const answer = (req: GenerateRequest): GenerateResult => {
    const last = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const fail = /\[\[MOCK_ERROR:(blocked|payment_required)\]\]/.exec(last)?.[1] as AiErrorCode | undefined;
    if (fail) throw new AiError(fail);
    const words = last.trim().split(/\s+/).filter(Boolean).length;
    const forced = /\[\[MOCK_REPLY:([\s\S]*?)\]\]$/m.exec(last)?.[1];
    const text = forced ?? `[MOCK DRAFT] Thanks for your message (${words} words). A teammate will follow up shortly. Let me know if there is anything else you need in the meantime.`;
    const usage = { inputTokens: est(req.messages.map((m) => m.content).join("\n")), outputTokens: est(text) };
    const t = /\[\[MOCK_TOOL:([a-zA-Z0-9_-]+):(\{[^\n]*?\})\]\]/.exec(last);
    if (t && req.tools?.some((x) => x.function.name === t[1])) return { text, usage, finishReason: "tool_calls", toolCalls: [{ id: "call_mock_1", name: t[1]!, arguments: t[2]! }] };
    return { text, usage, finishReason: "stop" };
  };
  return {
    id: "mock",
    async generate(req) { return answer(req); },
    /** Deterministic chunks of 8 characters; stops quietly when the signal aborts. */
    async *generateStream(req): AsyncGenerator<StreamEvent> {
      const g = answer(req);
      const slow = /\[\[MOCK_SLOW\]\]/.test([...req.messages].reverse().find((m) => m.role === "user")?.content ?? "");
      for (let i = 0; i < g.text.length; i += 8) {
        if (req.signal?.aborted) return;
        yield { type: "delta", text: g.text.slice(i, i + 8) };
        await new Promise((r) => setTimeout(r, slow ? 300 : 25));
      }
      if (req.signal?.aborted) return;
      yield { type: "usage", ...g.usage };
      yield { type: "done", finishReason: "stop" };
    },
    // Mock media output is labelled and derived only from the input's mime, size and hash, never from its content.
    async vision(r) {
      if (r.media.kind !== "image") throw new AiError("unsupported_capability");
      return mediaResult(r, r.prompt.includes("Question:") ? `[MOCK ANSWER] A mock answer about the image (${tag(r.media)}).` : `[MOCK IMAGE DESCRIPTION] A mock description of an image (${tag(r.media)}).`);
    },
    async document(r) {
      if (r.media.kind === "audio") throw new AiError("unsupported_capability");
      return mediaResult(r, `[MOCK DOCUMENT TEXT] Mock extracted text of a ${r.media.kind} (${tag(r.media)}).\n\nThis text is produced offline for testing and is not the real content of the file.`);
    },
    async transcribe(r) {
      if (r.media.kind !== "audio") throw new AiError("unsupported_capability");
      const text = `[MOCK TRANSCRIPT] Mock transcript of audio (${tag(r.media)}).`;
      return { text, usage: { inputTokens: 0, outputTokens: est(text) }, durationSec: estimateAudioSeconds(r.media.bytes.byteLength) };
    },
  };
}
