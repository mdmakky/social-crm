import { AiError } from "../types.ts";

export type HttpOptions = { fetch?: typeof fetch; timeoutMs?: number };

/** Maps an HTTP status to a typed error. The response body is never read into an error: providers can echo prompt text or key fragments. */
export function errorForStatus(status: number): AiError {
  if (status === 401 || status === 403) return new AiError("auth", status);
  if (status === 429) return new AiError("rate_limit", status);
  if (status === 408 || status === 504) return new AiError("timeout", status);
  if (status >= 500) return new AiError("provider_error", status); // includes 529 overloaded
  return new AiError("invalid_request", status);
}

/** One POST with a hard timeout. Returns parsed JSON; every failure is an AiError (network and bad JSON are provider_error, an abort is timeout). */
export async function postJson(url: string, headers: Record<string, string>, body: unknown, o: HttpOptions): Promise<unknown> {
  const f = o.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    throw new AiError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "provider_error");
  }
  if (!res.ok) throw errorForStatus(res.status);
  try {
    return await res.json();
  } catch {
    throw new AiError("provider_error", res.status);
  }
}

export const int = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
