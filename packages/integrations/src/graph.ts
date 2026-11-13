/**
 * Meta Graph client behind a port. The REAL implementation (createMetaGraph) has NEVER been run against Meta: every request/response shape
 * below comes from documentation fetched 2026-11-13 (docs/integrations/meta-oauth-readiness.md) and is UNVERIFIED until a recorded real request.
 * Tokens travel in the Authorization header or POST body, never in a URL we log; error messages never contain a token.
 */
export type GraphPage = { id: string; name: string; accessToken: string; tasks: string[]; instagramAccountId: string | null };
export type TokenInfo = { isValid: boolean; expiresAt: Date | null; scopes: string[]; errorCode: number | null };

export class GraphError extends Error {
  constructor(readonly code: number | null, readonly status: number, readonly kind: "auth" | "throttle" | "permission" | "other") {
    super(`graph_error_${code ?? status}`);
  }
}

export interface MetaGraph {
  /** Authorization-code exchange (redirect_uri must equal the one used for the dialog). */
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; expiresInSec: number | null }>;
  exchangeLongLived(userToken: string): Promise<{ accessToken: string; expiresInSec: number | null }>;
  /** Pages the user manages, each with its own Page token and the linked Instagram professional account id, if any. */
  listPages(userToken: string): Promise<GraphPage[]>;
  subscribePage(pageId: string, pageToken: string, fields: string[]): Promise<boolean>;
  unsubscribePage(pageId: string, pageToken: string): Promise<boolean>;
  debugToken(token: string): Promise<TokenInfo>;
}

const classify = (code: number | null, status: number): GraphError["kind"] =>
  code === 190 || status === 401 ? "auth" : code === 4 || code === 17 || code === 368 || status === 429 ? "throttle" : code === 10 || (code !== null && code >= 200 && code <= 299) ? "permission" : "other";

export function createMetaGraph(cfg: { appId: string; appSecret: string; version: string; fetch?: typeof fetch; baseUrl?: string }): MetaGraph {
  const f = cfg.fetch ?? fetch;
  const base = `${cfg.baseUrl ?? "https://graph.facebook.com"}/${cfg.version}`;
  const appToken = `${cfg.appId}|${cfg.appSecret}`;

  async function call(path: string, o: { method?: "GET" | "POST" | "DELETE"; token?: string; query?: Record<string, string>; form?: Record<string, string> } = {}) {
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = {};
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    let body: URLSearchParams | undefined;
    if (o.form) {
      body = new URLSearchParams(o.form);
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    let res: Response;
    try {
      res = await f(url, { method: o.method ?? "GET", headers, body, signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new GraphError(null, 0, "other"); // network or timeout: no detail (the URL may hold a secret)
    }
    const json = (await res.json().catch(() => null)) as { error?: { code?: number }; [k: string]: unknown } | null;
    if (!res.ok || json?.error) {
      const code = json?.error?.code ?? null;
      throw new GraphError(code, res.status, classify(code, res.status));
    }
    return json as Record<string, unknown>;
  }
  const tokenOf = (j: Record<string, unknown>) => {
    if (typeof j.access_token !== "string" || !j.access_token) throw new GraphError(null, 200, "other");
    return { accessToken: j.access_token, expiresInSec: typeof j.expires_in === "number" ? j.expires_in : null };
  };

  return {
    async exchangeCode(code, redirectUri) {
      return tokenOf(await call("/oauth/access_token", { query: { client_id: cfg.appId, client_secret: cfg.appSecret, redirect_uri: redirectUri, code } }));
    },
    async exchangeLongLived(userToken) {
      return tokenOf(await call("/oauth/access_token", { query: { grant_type: "fb_exchange_token", client_id: cfg.appId, client_secret: cfg.appSecret, fb_exchange_token: userToken } }));
    },
    async listPages(userToken) {
      const out: GraphPage[] = [];
      const next: string | null = "/me/accounts";
      let query: Record<string, string> | undefined = { fields: "id,name,access_token,tasks,instagram_business_account{id}", limit: "100" };
      for (let i = 0; next && i < 10; i++) {
        const j = (await call(next, { token: userToken, query })) as { data?: Record<string, unknown>[]; paging?: { cursors?: { after?: string }; next?: string } };
        for (const p of j.data ?? []) {
          if (typeof p.id !== "string" || typeof p.access_token !== "string") continue;
          const ig = (p.instagram_business_account as { id?: unknown } | undefined)?.id;
          out.push({ id: p.id, name: typeof p.name === "string" ? p.name : p.id, accessToken: p.access_token, tasks: Array.isArray(p.tasks) ? p.tasks.filter((t): t is string => typeof t === "string") : [], instagramAccountId: typeof ig === "string" ? ig : null });
        }
        const after = j.paging?.next ? j.paging.cursors?.after : undefined;
        if (!after) break;
        query = { fields: "id,name,access_token,tasks,instagram_business_account{id}", limit: "100", after };
      }
      return out;
    },
    async subscribePage(pageId, pageToken, fields) {
      const j = await call(`/${encodeURIComponent(pageId)}/subscribed_apps`, { method: "POST", token: pageToken, form: { subscribed_fields: fields.join(",") } });
      return j.success === true;
    },
    async unsubscribePage(pageId, pageToken) {
      // Documentation names an app access token for DELETE; the Page token is tried first by callers that have it. UNVERIFIED which is accepted.
      const j = await call(`/${encodeURIComponent(pageId)}/subscribed_apps`, { method: "DELETE", token: pageToken || appToken });
      return j.success === true;
    },
    async debugToken(token) {
      const j = (await call("/debug_token", { token: appToken, query: { input_token: token } })) as { data?: { is_valid?: boolean; expires_at?: number; scopes?: string[]; error?: { code?: number } } };
      const d = j.data ?? {};
      return { isValid: d.is_valid === true, expiresAt: typeof d.expires_at === "number" && d.expires_at > 0 ? new Date(d.expires_at * 1000) : null, scopes: Array.isArray(d.scopes) ? d.scopes : [], errorCode: d.error?.code ?? null };
    },
  };
}

/** MOCK ONLY: in-memory Graph for tests and mock mode. Behaviour is whatever the test configures; it proves our code, not Meta's. */
export function createMockGraph(state: { pages?: GraphPage[]; validCodes?: Set<string>; tokenInfo?: Map<string, TokenInfo>; failSubscribe?: boolean } = {}): MetaGraph & { calls: string[]; state: typeof state } {
  const calls: string[] = [];
  const codes = state.validCodes ?? new Set(["good-code"]);
  return {
    calls,
    state,
    async exchangeCode(code) {
      calls.push("exchangeCode");
      if (!codes.has(code)) throw new GraphError(100, 400, "other");
      return { accessToken: "mock-user-token", expiresInSec: 3600 };
    },
    async exchangeLongLived() {
      calls.push("exchangeLongLived");
      return { accessToken: "mock-long-user-token", expiresInSec: 5_183_944 };
    },
    async listPages() {
      calls.push("listPages");
      return state.pages ?? [];
    },
    async subscribePage(pageId) {
      calls.push(`subscribe:${pageId}`);
      if (state.failSubscribe) throw new GraphError(200, 403, "permission");
      return true;
    },
    async unsubscribePage(pageId) {
      calls.push(`unsubscribe:${pageId}`);
      return true;
    },
    async debugToken(token) {
      calls.push("debugToken");
      return state.tokenInfo?.get(token) ?? { isValid: true, expiresAt: null, scopes: [], errorCode: null };
    },
  };
}
