/**
 * Meta Graph client behind a port. The REAL implementation (createMetaGraph) has NEVER been run against Meta: every request/response shape
 * below comes from documentation fetched 2026-11-13 (docs/integrations/meta-oauth-readiness.md) and is UNVERIFIED until a recorded real request.
 * Tokens travel in the Authorization header or POST body, never in a URL we log; error messages never contain a token.
 */
/** `tasks` is null when Graph did not return the field (then eligibility cannot be checked: UNVERIFIED whether /me/accounts returns it for every token). */
export type GraphPage = { id: string; name: string; accessToken: string; tasks: string[] | null; instagramAccountId: string | null; /** filled in by the connect callback, not by Graph's account list */ instagram?: InstagramAccountInfo | null };
export type TokenInfo = { /** app the token was issued to (debug_token app_id); null when Graph did not say */ appId?: string | null; isValid: boolean; expiresAt: Date | null; scopes: string[]; errorCode: number | null };

/** One phone number of a WhatsApp Business Account (GET /{waba-id}/phone_numbers). `id` is the phone number id used as the webhook routing key. */
export type WhatsAppNumber = { id: string; displayPhoneNumber: string; verifiedName: string | null };

export type InstagramAccountInfo = { username: string | null; name: string | null; pictureUrl: string | null };

/** `null` from getUserProfile means Graph answered with an empty object: the app has no profile access for this person (documented behaviour). */
export type UserProfile = { name: string | null; picUrl: string | null };

/** Display name from Graph: single line, no control characters, bounded. Anything else is dropped so the placeholder stays. */
export function cleanProfileName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  return s.length > 0 && s.length <= 120 ? s : null;
}
const PIC_HOSTS = /(^|\.)(fbcdn\.net|fbsbx\.com|cdninstagram\.com|facebook\.com)$/;
/** Profile picture URL: https only, a Meta CDN host, bounded. The URL expires on Meta's side (documented), so it is stored as a hint, not as an asset. */
export function safePicUrl(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 2048) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && PIC_HOSTS.test(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

export class GraphError extends Error {
  constructor(readonly code: number | null, readonly status: number, readonly kind: "auth" | "throttle" | "permission" | "other") {
    super(`graph_error_${code ?? status}`);
  }
}

/**
 * Outcome of a Send API call that did NOT return a message id.
 * `rejected`: Meta answered with a 4xx error body, so the message was refused and nothing was delivered (safe to show as failed).
 * `ambiguous`: timeout, network failure, 5xx, or a reply we could not read. The request may have reached Meta, so the message might have been delivered. Never retried automatically.
 */
export class SendError extends Error {
  constructor(readonly outcome: "rejected" | "ambiguous", readonly httpStatus: number | null, readonly code: number | null, readonly subcode: number | null) {
    super(`send_${outcome}_${code ?? httpStatus ?? "none"}`); // no response text: it could echo the message or the recipient
  }
}

export interface MetaGraph {
  /**
   * Messenger Send API (text only, standard messaging): POST /{version}/{PAGE_ID}/messages with the Page token, `messaging_type: "RESPONSE"`.
   * Meta documents no idempotency key (checked 2026-11-14), so a second call can deliver a second copy: callers must never repeat a call whose result is ambiguous.
   * Throws SendError; returns Meta's message id on success.
   * channel "whatsapp" (Cloud API, UNVERIFIED until a recorded real request): `pageId` is the phone number id, `psid` the recipient wa_id; POST /{phone-number-id}/messages {messaging_product:"whatsapp", to, type:"text", text:{body}}, id read from messages[0].id.
   */
  sendText(pageId: string, pageToken: string, psid: string, text: string, channel?: "messenger" | "instagram" | "instagram_unified" | "whatsapp"): Promise<{ messageId: string }>;
  /**
   * Unified Login: GET me/assigned_instagram_accounts?fields=id,username with the system-user token (migration guide, 2026-11-14). The id is the Instagram professional account id used in webhooks.
   * Throws GraphError. At most 25 accounts are read.
   */
  listAssignedInstagramAccounts(token: string): Promise<{ id: string; username: string | null }[]>;
  /**
   * WhatsApp manual connection (system-user token): GET /{waba-id}/phone_numbers?fields=id,display_phone_number,verified_name with the token.
   * Throws GraphError (190 invalid token, 100/200 family: no access to that WABA). At most 25 numbers are read. Shapes follow Meta's reference, UNVERIFIED until a recorded real request.
   */
  listWhatsAppNumbers(token: string, wabaId: string): Promise<WhatsAppNumber[]>;
  /**
   * WhatsApp Cloud API media lookup: GET /{media-id} with the token returns {url, mime_type, file_size, ...}; the url is then fetched with the SAME Bearer token (done by the caller through the SSRF-safe downloader).
   * Throws GraphError (a 404 means the media expired or was never ours). Response shape follows Meta's reference, UNVERIFIED until a recorded real request.
   */
  getWhatsAppMedia(mediaId: string, token: string): Promise<{ url: string; mime: string | null; size: number | null }>;
  /** POST /{waba-id}/subscribed_apps with the token: subscribes THIS app to the WABA's webhooks (fields are configured on the app). */
  subscribeWaba(wabaId: string, token: string): Promise<boolean>;
  /** Instagram professional account details for the connect screen (best effort: null on any failure). Fields as in the Graph IG User object; UNVERIFIED against the pages read 2026-11-14. */
  getInstagramAccount(igId: string, pageToken: string): Promise<InstagramAccountInfo | null>;
  /** Authorization-code exchange (redirect_uri must equal the one used for the dialog). */
  exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; expiresInSec: number | null }>;
  exchangeLongLived(userToken: string): Promise<{ accessToken: string; expiresInSec: number | null }>;
  /** App-scoped id of the person who authorised (GET /me?fields=id; standard Graph, response shape UNVERIFIED here). */
  getUserId(userToken: string): Promise<string | null>;
  /** Pages the user manages, each with its own Page token and the linked Instagram professional account id, if any. */
  listPages(userToken: string): Promise<GraphPage[]>;
  subscribePage(pageId: string, pageToken: string, fields: string[]): Promise<boolean>;
  unsubscribePage(pageId: string, pageToken: string): Promise<boolean>;
  debugToken(token: string): Promise<TokenInfo>;
  /** Messenger User Profile API: GET /<PSID>?fields=name,profile_pic with the Page token. Needs Advanced Access to "Business Asset User Profile Access" (docs, 2026-11-14); without it Graph returns an empty object, mapped to null here. */
  getUserProfile(psid: string, pageToken: string, channel?: "messenger" | "instagram"): Promise<UserProfile | null>;
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
    async getUserId(userToken) {
      const j = await call("/me", { token: userToken, query: { fields: "id" } });
      return typeof j.id === "string" && /^[0-9]{1,40}$/.test(j.id) ? j.id : null;
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
          out.push({ id: p.id, name: typeof p.name === "string" ? p.name : p.id, accessToken: p.access_token, tasks: Array.isArray(p.tasks) ? p.tasks.filter((t): t is string => typeof t === "string") : null, instagramAccountId: typeof ig === "string" ? ig : null });
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
    async sendText(pageId, pageToken, psid, text, channel = "messenger") {
      let res: Response;
      try {
        // Instagram: the account id we store is the Instagram id, not the Page id, so the documented `me/messages` form (Page token) is used. The Instagram docs show no messaging_type, so none is sent.
        // Unified Login: the token is a system-user token, for which `me` is the system user, so the Instagram account id is addressed explicitly: POST /{ig-id}/messages (migration guide).
        const url = channel === "instagram" ? `${base}/me/messages` : `${base}/${encodeURIComponent(pageId)}/messages`;
        const payload = channel === "whatsapp" ? { messaging_product: "whatsapp", recipient_type: "individual", to: psid, type: "text", text: { body: text } } : channel !== "messenger" ? { recipient: { id: psid }, message: { text } } : { recipient: { id: psid }, messaging_type: "RESPONSE", message: { text } };
        res = await f(url, {
          method: "POST",
          headers: { authorization: `Bearer ${pageToken}`, "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new SendError("ambiguous", null, null, null); // timeout or connection lost after the request may have been written
      }
      const json = (await res.json().catch(() => null)) as { error?: { code?: unknown; error_subcode?: unknown }; message_id?: unknown; messages?: { id?: unknown }[] } | null;
      if (res.ok && !json?.error) {
        const id = channel === "whatsapp" ? json?.messages?.[0]?.id : json?.message_id;
        if (typeof id === "string" && id) return { messageId: id };
        throw new SendError("ambiguous", res.status, null, null); // 2xx without an id: accepted or not, we cannot tell
      }
      const code = typeof json?.error?.code === "number" ? json.error.code : null;
      const sub = typeof json?.error?.error_subcode === "number" ? json.error.error_subcode : null;
      // A 4xx with a readable Graph error is a refusal. A 5xx (or an unreadable body) may hide a request that was processed.
      throw new SendError(res.status >= 400 && res.status < 500 && code !== null ? "rejected" : "ambiguous", res.status, code, sub);
    },
    async listAssignedInstagramAccounts(token) {
      const j = (await call("/me/assigned_instagram_accounts", { token, query: { fields: "id,username", limit: "25" } })) as { data?: Record<string, unknown>[] };
      const out: { id: string; username: string | null }[] = [];
      for (const a of (j.data ?? []).slice(0, 25)) {
        if (typeof a.id !== "string" || !/^[1-9][0-9]{0,99}$/.test(a.id)) continue;
        out.push({ id: a.id, username: typeof a.username === "string" && /^[A-Za-z0-9._]{1,30}$/.test(a.username) ? a.username : null });
      }
      return out;
    },
    async listWhatsAppNumbers(token, wabaId) {
      const j = (await call(`/${encodeURIComponent(wabaId)}/phone_numbers`, { token, query: { fields: "id,display_phone_number,verified_name", limit: "25" } })) as { data?: Record<string, unknown>[] };
      const out: WhatsAppNumber[] = [];
      for (const n of (j.data ?? []).slice(0, 25)) {
        if (typeof n.id !== "string" || !/^[1-9][0-9]{0,99}$/.test(n.id) || typeof n.display_phone_number !== "string") continue;
        out.push({ id: n.id, displayPhoneNumber: n.display_phone_number.replace(/[^0-9+()\- ]/g, "").slice(0, 32), verifiedName: cleanProfileName(n.verified_name) });
      }
      return out;
    },
    async getWhatsAppMedia(mediaId, token) {
      const j = await call(`/${encodeURIComponent(mediaId)}`, { token });
      if (typeof j.url !== "string" || !j.url.startsWith("https://") || j.url.length > 2000) throw new GraphError(null, 200, "other");
      return { url: j.url, mime: typeof j.mime_type === "string" && j.mime_type.length <= 127 ? j.mime_type : null, size: typeof j.file_size === "number" && Number.isSafeInteger(j.file_size) ? j.file_size : null };
    },
    async subscribeWaba(wabaId, token) {
      const j = await call(`/${encodeURIComponent(wabaId)}/subscribed_apps`, { method: "POST", token });
      return j.success === true;
    },
    async getInstagramAccount(igId, pageToken) {
      try {
        const j = await call(`/${encodeURIComponent(igId)}`, { token: pageToken, query: { fields: "username,name,profile_picture_url" } });
        const username = typeof j.username === "string" && /^[A-Za-z0-9._]{1,30}$/.test(j.username) ? j.username : null;
        const info = { username, name: cleanProfileName(j.name), pictureUrl: safePicUrl(j.profile_picture_url) };
        return info.username || info.name || info.pictureUrl ? info : null;
      } catch {
        return null;
      }
    },
    async getUserProfile(psid, pageToken, channel = "messenger") {
      // Instagram: name, username, profile_pic (user profile page, 2026-11-14). A person without a name is shown by username.
      const j = await call(`/${encodeURIComponent(psid)}`, { token: pageToken, query: { fields: channel === "instagram" ? "name,username,profile_pic" : "name,profile_pic" } });
      const name = cleanProfileName(j.name) ?? (channel === "instagram" && typeof j.username === "string" && /^[A-Za-z0-9._]{1,30}$/.test(j.username) ? j.username : null);
      const picUrl = safePicUrl(j.profile_pic);
      return name === null && picUrl === null ? null : { name, picUrl };
    },
    async debugToken(token) {
      const j = (await call("/debug_token", { token: appToken, query: { input_token: token } })) as { data?: { app_id?: string; is_valid?: boolean; expires_at?: number; scopes?: string[]; error?: { code?: number } } };
      const d = j.data ?? {};
      return { appId: typeof d.app_id === "string" ? d.app_id : null, isValid: d.is_valid === true, expiresAt: typeof d.expires_at === "number" && d.expires_at > 0 ? new Date(d.expires_at * 1000) : null, scopes: Array.isArray(d.scopes) ? d.scopes : [], errorCode: d.error?.code ?? null };
    },
  };
}

/** MOCK ONLY: in-memory Graph for tests and mock mode. Behaviour is whatever the test configures; it proves our code, not Meta's. */
export function createMockGraph(state: { pages?: GraphPage[]; validCodes?: Set<string>; tokenInfo?: Map<string, TokenInfo>; failSubscribe?: boolean; /** WhatsApp: token and numbers per WABA id; failSubscribeWaba makes the webhook subscription fail */ whatsapp?: { wabas: Map<string, { token: string; numbers: WhatsAppNumber[] }>; failSubscribeWaba?: boolean }; metaUserId?: string | null; profiles?: Map<string, UserProfile | null | GraphError>; instagram?: Map<string, InstagramAccountInfo>; /** token -> accounts shared through Unified Login, or an error */ assigned?: Map<string, { id: string; username: string | null }[] | GraphError>; /** next sendText results, consumed in order; default is success with a generated id */ sends?: (string | SendError)[]; /** runs inside sendText before it answers (tests use it to race an echo) */ onSend?: () => Promise<void>; /** WhatsApp media id -> lookup result (or an error); default is a mock lookaside url */ waMedia?: Map<string, { url: string; mime: string | null; size: number | null } | GraphError> } = {}): MetaGraph & { calls: string[]; state: typeof state } {
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
    async getUserId() {
      calls.push("getUserId");
      return state.metaUserId === undefined ? "9000000000000001" : state.metaUserId;
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
    async listAssignedInstagramAccounts(token) {
      calls.push("assignedAccounts");
      const a = state.assigned?.get(token);
      if (a instanceof GraphError) throw a;
      return a ?? [];
    },
    async getWhatsAppMedia(mediaId) {
      calls.push(`wamedia:${mediaId}`);
      const m = state.waMedia?.get(mediaId);
      if (m instanceof GraphError) throw m;
      return m ?? { url: `https://lookaside.fbsbx.com/mock/${mediaId}`, mime: null, size: null };
    },
    async listWhatsAppNumbers(token, wabaId) {
      calls.push(`wanumbers:${wabaId}`);
      const w = state.whatsapp?.wabas.get(wabaId);
      if (!w) throw new GraphError(100, 400, "other");
      if (w.token !== token) throw new GraphError(190, 401, "auth");
      return w.numbers;
    },
    async subscribeWaba(wabaId) {
      calls.push(`subscribewaba:${wabaId}`);
      if (state.whatsapp?.failSubscribeWaba) throw new GraphError(200, 403, "permission");
      return true;
    },
    async getInstagramAccount(igId) {
      calls.push(`igaccount:${igId}`);
      return state.instagram?.get(igId) ?? null;
    },
    async sendText(pageId, _token, psid, text, channel = "messenger") {
      calls.push(`${channel === "whatsapp" ? "sendwa" : channel === "instagram" ? "sendig" : channel === "instagram_unified" ? "sendigu" : "send"}:${pageId}:${psid}:${text}`);
      await state.onSend?.();
      const next = state.sends?.shift();
      if (next instanceof SendError) throw next;
      return { messageId: next ?? `mock.mid.${calls.length}.${Math.random().toString(36).slice(2, 10)}` };
    },
    async getUserProfile(psid) {
      calls.push(`profile:${psid}`);
      const p = state.profiles?.get(psid);
      if (p instanceof GraphError) throw p;
      return p ?? null;
    },
    async debugToken(token) {
      calls.push("debugToken");
      return state.tokenInfo?.get(token) ?? { isValid: true, expiresAt: null, scopes: [], errorCode: null };
    },
  };
}
