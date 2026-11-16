import type { AiProvider } from "../types.ts";

const est = (s: string) => Math.max(1, Math.ceil(s.length / 4));

/** Deterministic, offline, free. Output depends only on the last user message, so tests and the demo are repeatable. Every draft says it is a mock. */
export function createMockProvider(): AiProvider {
  return {
    id: "mock",
    async generate(req) {
      const last = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const words = last.trim().split(/\s+/).filter(Boolean).length;
      const text = `[MOCK DRAFT] Thanks for your message (${words} words). A teammate will follow up shortly.`;
      return { text, usage: { inputTokens: est(req.messages.map((m) => m.content).join("\n")), outputTokens: est(text) }, finishReason: "stop" };
    },
  };
}
