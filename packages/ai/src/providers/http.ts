import { AiError } from "../types.ts";

/** `gateway`: OpenRouter semantics (402 payment_required, 403 blocked, 502/503 retryable, errors inside a 200 body, Retry-After). Off for every other provider. */
export type HttpOptions = { fetch?: typeof fetch; timeoutMs?: number; gateway?: boolean; /** Extra abort source (the caller went away), combined with the timeout. */ signal?: AbortSignal };

export const MAX_RETRY_AFTER_MS = 30_000;

/** Retry-After as seconds or an HTTP date, in ms, capped at 30 s. Anything unreadable is undefined. */
export function parseRetryAfter(v: string | null | undefined, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const t = v.trim();
  const ms = /^\d+(\.\d+)?$/.test(t) ? Number(t) * 1000 : Date.parse(t) - now;
  return Number.isFinite(ms) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.ceil(ms))) : undefined;
}

/** Maps an HTTP status to a typed error. The response body is never read into an error: providers can echo prompt text or key fragments. */
export function errorForStatus(status: number, gateway = false, retryAfterMs?: number): AiError {
  if (gateway) {
    const x = (retryable: boolean) => ({ retryable, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
    if (status === 401) return new AiError("auth", status, x(false));
    if (status === 402) return new AiError("payment_required", status, x(false));
    if (status === 403) return new AiError("blocked", status, x(false));
    if (status === 408 || status === 504) return new AiError("timeout", status, x(true));
    if (status === 429) return new AiError("rate_limit", status, x(true));
    if (status === 502 || status === 503) return new AiError("provider_error", status, x(true));
    if (status >= 500) return new AiError("provider_error", status, x(false));
    return new AiError("invalid_request", status, x(false));
  }
  if (status === 401 || status === 403) return new AiError("auth", status);
  if (status === 429) return new AiError("rate_limit", status);
  if (status === 408 || status === 504) return new AiError("timeout", status);
  if (status >= 500) return new AiError("provider_error", status); // includes 529 overloaded
  return new AiError("invalid_request", status);
}

/** One POST with a hard timeout. Returns parsed JSON; every failure is an AiError (network and bad JSON are provider_error, an abort is timeout). */
export const postJson = (url: string, headers: Record<string, string>, body: unknown, o: HttpOptions): Promise<unknown> =>
  post(url, { "content-type": "application/json", ...headers }, JSON.stringify(body), o);

/** Same as postJson for a ready body. Multipart bodies pass no content-type: fetch adds the boundary. */
export async function post(url: string, headers: Record<string, string>, body: BodyInit, o: HttpOptions): Promise<unknown> {
  const f = o.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(url, { method: "POST", headers, body, signal: o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs ?? 30_000)]) : AbortSignal.timeout(o.timeoutMs ?? 30_000) });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    throw new AiError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "provider_error");
  }
  const retryAfter = o.gateway ? parseRetryAfter(res.headers?.get("retry-after")) : undefined;
  if (!res.ok) throw errorForStatus(res.status, o.gateway, retryAfter);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new AiError("provider_error", res.status);
  }
  // OpenRouter answers HTTP 200 with `{error:{code}}` when a failure happens after the request was accepted. Only the numeric code is read; the message and metadata are dropped.
  if (o.gateway && json && typeof json === "object" && "error" in json && (json as { error?: unknown }).error) {
    const code = ((json as { error: { code?: unknown } }).error as { code?: unknown } | null)?.code;
    throw typeof code === "number" && Number.isInteger(code) && code >= 400 && code < 600 ? errorForStatus(code, true, retryAfter) : new AiError("provider_error", res.status);
  }
  return json;
}

export const int = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);

/**
 * USD credits (a JSON number such as 0.0000153) to integer micro-units, rounded UP (a tiny overcount beats undercounting a budget).
 * Decimal-string math on a fixed 12-digit rendering: no float multiplication. Negative, NaN, Infinity or above 1 000 000 USD gives undefined.
 */
export function usdToMicroCeil(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1_000_000) return undefined;
  const [whole, frac = ""] = v.toFixed(12).split(".");
  const micro = BigInt(whole!) * 1_000_000n + BigInt(frac.slice(0, 6));
  return Number(/[1-9]/.test(frac.slice(6)) ? micro + 1n : micro);
}
