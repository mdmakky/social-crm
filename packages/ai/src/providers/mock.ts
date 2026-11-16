import { estimateAudioSeconds, estimateMediaTokens } from "../media.ts";
import { fingerprintBytes } from "../logging.ts";
import { AiError, type AiProvider, type MediaRequest } from "../types.ts";

const est = (s: string) => Math.max(1, Math.ceil(s.length / 4));

/** Stable one-line identity of a media input: depends only on mime, size and content hash. */
const tag = (m: MediaRequest["media"]) => `${m.mime}, ${m.bytes.byteLength} bytes, hash ${fingerprintBytes(m.bytes).slice(0, 8)}`;

/** Deterministic, offline, free. Output depends only on the last user message, so tests and the demo are repeatable. Every draft says it is a mock. */
export function createMockProvider(): AiProvider {
  const mediaResult = (r: MediaRequest, text: string) => ({ text, usage: { inputTokens: estimateMediaTokens(r.media.kind, r.media.bytes.byteLength) + est(r.prompt), outputTokens: est(text) }, finishReason: "stop" as const });
  return {
    id: "mock",
    async generate(req) {
      const last = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const words = last.trim().split(/\s+/).filter(Boolean).length;
      // Test hook: `[[MOCK_REPLY:{...}]]` in the user message makes the mock answer with exactly that text, so agent tool-call flows are deterministic offline.
      const forced = /\[\[MOCK_REPLY:([\s\S]*?)\]\]$/m.exec(last)?.[1];
      const text = forced ?? `[MOCK DRAFT] Thanks for your message (${words} words). A teammate will follow up shortly.`;
      return { text, usage: { inputTokens: est(req.messages.map((m) => m.content).join("\n")), outputTokens: est(text) }, finishReason: "stop" };
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
