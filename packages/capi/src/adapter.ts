import { CapiEvent } from "./event.ts";

export type SendRequest = { datasetId: string; accessToken: string; testEventCode?: string | null; events: CapiEvent[] };
export type SendResult =
  | { ok: true; fbtraceId?: string; eventsReceived: number }
  /** retryable: timeouts, 5xx, rate limits. Not retryable: validation and auth errors (architecture section 6). `code` is a short machine word, never Meta message text. */
  | { ok: false; retryable: boolean; code: string; fbtraceId?: string };

export interface CapiAdapter {
  /** "mock" never touches the network. "live" is built but NOT wired anywhere until a real test event is recorded (architecture section 10). */
  readonly mode: "mock" | "live";
  send(req: SendRequest): Promise<SendResult>;
}

export type MockScript = (req: SendRequest, call: number) => SendResult | undefined;

/** Validates the payload like the live path would, then returns the scripted outcome (default success). Records calls for tests. */
export function createMockAdapter(script?: MockScript): CapiAdapter & { calls: SendRequest[] } {
  const calls: SendRequest[] = [];
  return {
    mode: "mock",
    calls,
    async send(req) {
      calls.push(req);
      for (const e of req.events) if (!CapiEvent.safeParse(e).success) return { ok: false, retryable: false, code: "invalid_payload" };
      return script?.(req, calls.length) ?? { ok: true, eventsReceived: req.events.length, fbtraceId: "mock" };
    },
  };
}

/** Request for POST /{dataset_id}/events (research doc). The token goes in the body, never the URL, so it cannot land in access logs. */
export function buildEventsRequest(req: SendRequest, graphVersion: string) {
  return {
    url: `https://graph.facebook.com/${graphVersion}/${req.datasetId}/events`,
    body: { data: req.events, access_token: req.accessToken, ...(req.testEventCode ? { test_event_code: req.testEventCode } : {}) },
  };
}

type Reply = { events_received?: number; fbtrace_id?: string; error?: { code?: number; fbtrace_id?: string } };

/** Real adapter. Not used by the server in slice 1; tests drive it with a fake fetch only. */
export function createLiveAdapter(o: { graphVersion: string; fetch?: typeof fetch; timeoutMs?: number }): CapiAdapter {
  const f = o.fetch ?? fetch;
  return {
    mode: "live",
    async send(req) {
      const r = buildEventsRequest(req, o.graphVersion);
      let res: Response;
      try {
        res = await f(r.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(r.body), signal: AbortSignal.timeout(o.timeoutMs ?? 15_000) });
      } catch {
        return { ok: false, retryable: true, code: "network" };
      }
      const j = (await res.json().catch(() => null)) as Reply | null;
      const fbtraceId = j?.fbtrace_id ?? j?.error?.fbtrace_id;
      if (res.ok && typeof j?.events_received === "number") return { ok: true, eventsReceived: j.events_received, fbtraceId };
      if (res.ok) return { ok: false, retryable: true, code: "unreadable_response", fbtraceId };
      if (res.status === 429 || res.status >= 500) return { ok: false, retryable: true, code: `http_${res.status}`, fbtraceId };
      if (res.status === 401 || j?.error?.code === 190) return { ok: false, retryable: false, code: "auth", fbtraceId };
      return { ok: false, retryable: false, code: `http_${res.status}`, fbtraceId };
    },
  };
}
