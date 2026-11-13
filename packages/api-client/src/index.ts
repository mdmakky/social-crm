import type { z } from "zod";
import type { CallArgs, CallOutput, Endpoint } from "@crm/contracts";

export type ApiError = {
  /** http: the server answered with an error status. contract: a success body did not match the shared schema. */
  kind: "http" | "network" | "timeout" | "contract" | "invalid_request";
  status: number;
  code: string;
  message: string;
};
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export type AuthMode = { mode: "cookie" } | { mode: "bearer"; getToken: () => Promise<string | null> | string | null };

export type ApiClientOptions = {
  /** Empty string for same-origin browser calls. */
  baseUrl: string;
  auth: AuthMode;
  timeoutMs?: number;
  /** Extra headers per request, for example the visitor's cookie when calling from a server component. */
  headers?: () => Promise<Record<string, string>> | Record<string, string>;
  /** Override the default (cookie mode: include, bearer mode: omit). React Native sends a manual Cookie header with credentials "omit". */
  credentials?: RequestCredentials;
  onUnauthorized?: () => void;
  fetch?: typeof fetch;
};

const fail = (kind: ApiError["kind"], status: number, code: string, message: string): { ok: false; error: ApiError } => ({ ok: false, error: { kind, status, code, message } });

export function createApiClient(opts: ApiClientOptions) {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;

  async function call<E extends Endpoint>(ep: E, ...args: CallArgs<E>): Promise<ApiResult<CallOutput<E>>> {
    const input = (args[0] ?? {}) as { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown };

    let path = ep.path.replace(/:([A-Za-z0-9_]+)/g, (_, name: string) => encodeURIComponent(input.params?.[name] ?? ""));
    if (ep.query) {
      const q = ep.query.safeParse(input.query ?? {});
      if (!q.success) return fail("invalid_request", 0, "invalid_query", q.error.issues[0]?.message ?? "Invalid query");
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(q.data as Record<string, unknown>)) if (v !== undefined) sp.set(k, String(v));
      if ([...sp].length) path += `?${sp}`;
    }
    let body: string | undefined;
    if (ep.body) {
      const b = ep.body.safeParse(input.body);
      if (!b.success) return fail("invalid_request", 0, "invalid_body", b.error.issues[0]?.message ?? "Invalid request body");
      body = JSON.stringify(b.data);
    }

    const headers = new Headers(await opts.headers?.());
    headers.set("accept", "application/json");
    if (body !== undefined) headers.set("content-type", "application/json");
    if (opts.auth.mode === "bearer") {
      const token = await opts.auth.getToken();
      if (token) headers.set("authorization", `Bearer ${token}`);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}${path}`, { method: ep.method, headers, body, signal: ctrl.signal, credentials: opts.credentials ?? (opts.auth.mode === "cookie" ? "include" : "omit") });
    } catch (e) {
      if ((e as { name?: string }).name === "AbortError") return fail("timeout", 0, "timeout", "The request took too long. Check your connection and try again.");
      return fail("network", 0, "network", "Could not reach the server. Check your connection and try again.");
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      if (res.status === 401) opts.onUnauthorized?.();
      const parsed = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      return fail("http", res.status, parsed?.error?.code ?? `http_${res.status}`, parsed?.error?.message ?? res.statusText ?? "Request failed");
    }

    const raw = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    const out = (ep.response as z.ZodType).safeParse(raw);
    if (!out.success) return fail("contract", res.status, "contract_mismatch", `The server response does not match the shared contract for ${ep.method} ${ep.path}: ${out.error.issues[0]?.path.join(".") ?? ""} ${out.error.issues[0]?.message ?? ""}`.trim());
    return { ok: true, data: out.data as CallOutput<E> };
  }

  return { call };
}

export type ApiClient = ReturnType<typeof createApiClient>;
