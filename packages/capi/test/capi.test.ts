import { describe, expect, it } from "vitest";
import { backoffMs, buildEventsRequest, buildUserData, CapiEvent, consentGate, createLiveAdapter, createMockAdapter, eventId, MAX_EVENT_AGE_MS, normalize, sha256, staleness } from "../src/index.ts";

// em, ph, fn (Mary) and the non-ASCII fn vectors below are Meta's published examples, re-checked against the live page https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters on 2026-11-16 (the hex values also match `shasum -a 256`). ln, ct, st, zp, country and ext are OUR OWN shasum values over the normalised string, not Meta-published.
const V = {
  email: "62a14e44f765419d10fea99367361a727c12365e2520f32218d505ed9aa0f62f",
  phone: "e323ec626319ca94ee8bff2e4c87cf613be6ea19919ed1364124e16807ab3176",
  fn: "6915771be1c5aa0c886870b6951b03d7eafc121fea0e80a5ea83beb7c449f4ec",
  ln: "6627835f988e2c5e50533d491163072d3f4f41f5c8b04630150debb3722ca2dd",
  ct: "0007a3d64c01e23d5075203c5977c14e4f7e01a3fc570686fcc50b5e1dd42685",
  st: "6959097001d10501ac7d54c0bdb8db61420f658f2922cc26e46d536119a31126",
  zp: "b9a9cf3cd3723a2e91b7c23ecf68456e872b6e5d86e5cab7f3d45a7302da32c7",
  country: "79adb2a2fce5c6ba215fe5f27f532d4e7edbac4b6a5e09e1ef3a08084a904621",
  ext: "539592e511f53a25e95e402d80f2488651d0d9b896df2772d9c50357f56895eb",
};

describe("normalisation and hashing vectors", () => {
  it("em", () => {
    expect(buildUserData({ email: "  John_Smith@GMAIL.com " }).em).toEqual([V.email]);
    expect(buildUserData({ email: "not-an-email" }).em).toBeUndefined();
  });
  it("ph: digits only, no leading zeros", () => {
    expect(buildUserData({ phone: "+1 (650) 555-1212" }).ph).toEqual([V.phone]);
    expect(buildUserData({ phone: "001-650-555-1212" }).ph).toEqual([V.phone]);
    expect(buildUserData({ phone: "12345" }).ph).toBeUndefined(); // too short to carry a country code
  });
  it("fn, ln", () => {
    expect(buildUserData({ firstName: " Mary! ", lastName: "SMITH." })).toMatchObject({ fn: [V.fn], ln: [V.ln] });
  });
  it("fn keeps non-ASCII letters (Meta's published Valéry and 정 vectors)", () => {
    expect(buildUserData({ firstName: "Valéry" }).fn).toEqual(["08e1996b5dd49e62a4b4c010d44e4345592a863bb9f8e3976219bac29417149c"]);
    expect(buildUserData({ firstName: "정" }).fn).toEqual(["8fa8cd9c440be61d0151429310034083132b35975c4bea67fdd74158eb51db14"]);
  });
  it("ct, st, zp, country", () => {
    const u = buildUserData({ city: "Menlo Park", state: "CA", zip: "94025-1234", country: "US" });
    expect(u).toMatchObject({ ct: [V.ct], st: [V.st], zp: [V.zp], country: [V.country] });
    expect(buildUserData({ zip: "M1 1AB" }).zp).toEqual([sha256("m11ab")]);
    expect(buildUserData({ country: "USA" }).country).toBeUndefined();
  });
  it("external_id keeps case and trims", () => {
    expect(buildUserData({ externalId: " contact-123 " }).external_id).toEqual([V.ext]);
    expect(normalize.external_id("ABC")).toBe("ABC");
  });
  it("fbp and fbc are never hashed and never invented", () => {
    const fbp = "fb.1.1596403881668.1116446470";
    const fbc = "fb.1.1554763741205.AbCdEfGhIjKlMnOpQrStUvWxYz1234567890";
    expect(buildUserData({ fbp, fbc })).toEqual({ fbp, fbc });
    expect(buildUserData({ fbp: "garbage", fbc: "also-garbage" })).toEqual({});
    expect(buildUserData({})).toEqual({});
  });
  it("output never contains the raw input", () => {
    const u = JSON.stringify(buildUserData({ email: "jane@example.com", phone: "+8801712345678", firstName: "Jane", lastName: "Doe" }));
    for (const raw of ["jane@example.com", "8801712345678", "jane\"", "doe\""]) expect(u).not.toContain(raw);
  });
});

const base = { event_name: "Lead", event_time: 1_700_000_000, event_id: "abcdefgh12", action_source: "system_generated", user_data: buildUserData({ email: "a@b.co" }) };
describe("payload validation", () => {
  it("accepts a hashed lead; rejects raw PII fields and unhashed values", () => {
    expect(CapiEvent.safeParse(base).success).toBe(true);
    expect(CapiEvent.safeParse({ ...base, user_data: { em: ["a@b.co"] } }).success).toBe(false);
    expect(CapiEvent.safeParse({ ...base, user_data: { email: "a@b.co" } }).success).toBe(false);
    expect(CapiEvent.safeParse({ ...base, event_name: "PageView" }).success).toBe(false);
  });
  it("Purchase needs value and a 3-letter currency", () => {
    expect(CapiEvent.safeParse({ ...base, event_name: "Purchase" }).success).toBe(false);
    expect(CapiEvent.safeParse({ ...base, event_name: "Purchase", custom_data: { value: 10 } }).success).toBe(false);
    expect(CapiEvent.safeParse({ ...base, event_name: "Purchase", custom_data: { value: 10.5, currency: "USD" } }).success).toBe(true);
    expect(CapiEvent.safeParse({ ...base, event_name: "Purchase", custom_data: { value: 10, currency: "usd" } }).success).toBe(false);
  });
  it("staleness: more than 7 days is too old", () => {
    const now = 1_800_000_000_000;
    expect(staleness(now / 1000 - 60, now)).toBe("ok");
    expect(staleness((now - MAX_EVENT_AGE_MS - 1000) / 1000, now)).toBe("too_old");
    expect(staleness(now / 1000 + 3600, now)).toBe("in_future");
  });
});

describe("event_id", () => {
  const i = { workspaceId: "w1", datasetId: "d1", crmEventRef: "lead:1:won", eventName: "Purchase" };
  it("is stable and sensitive to every part", () => {
    expect(eventId(i)).toBe(eventId({ ...i }));
    expect(eventId(i)).toMatch(/^[0-9a-f]{40}$/);
    for (const k of Object.keys(i) as (keyof typeof i)[]) expect(eventId({ ...i, [k]: i[k] + "x" })).not.toBe(eventId(i));
  });
});

describe("consent gate", () => {
  it("denies by default and honours opt-out", () => {
    expect(consentGate(null)).toEqual({ allow: false, reason: "no_consent" });
    expect(consentGate(undefined)).toEqual({ allow: false, reason: "no_consent" });
    expect(consentGate({ status: "revoked" })).toEqual({ allow: false, reason: "opted_out" });
    expect(consentGate({ status: "granted" })).toEqual({ allow: true });
  });
});

describe("backoff", () => {
  it("doubles from 2 minutes and caps at 6 hours", () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([2, 4, 8, 16].map((m) => m * 60_000));
    expect(backoffMs(20)).toBe(6 * 3_600_000);
  });
});

describe("adapters", () => {
  const req = { datasetId: "123456", accessToken: "tok-secret", testEventCode: "TEST1", events: [CapiEvent.parse(base)] };
  it("mock validates, records, and follows the script", async () => {
    const m = createMockAdapter((_r, n) => (n === 1 ? { ok: false, retryable: true, code: "http_503" } : undefined));
    expect(await m.send(req)).toEqual({ ok: false, retryable: true, code: "http_503" });
    expect((await m.send(req)).ok).toBe(true);
    expect(await m.send({ ...req, events: [{ ...base, user_data: { em: ["raw@x.com"] } } as never] })).toMatchObject({ ok: false, retryable: false, code: "invalid_payload" });
  });
  it("live request shape: POST /{dataset_id}/events, token in body not URL", () => {
    const r = buildEventsRequest(req, "v25.0");
    expect(r.url).toBe("https://graph.facebook.com/v25.0/123456/events");
    expect(r.url).not.toContain("tok-secret");
    expect(r.body).toMatchObject({ access_token: "tok-secret", test_event_code: "TEST1", data: req.events });
  });
  it("live adapter classifies outcomes (fake fetch, no network)", async () => {
    const reply = (status: number, j: unknown) => (async () => new Response(JSON.stringify(j), { status })) as unknown as typeof fetch;
    const send = (f: typeof fetch) => createLiveAdapter({ graphVersion: "v25.0", fetch: f }).send(req);
    expect(await send(reply(200, { events_received: 1, fbtrace_id: "T" }))).toEqual({ ok: true, eventsReceived: 1, fbtraceId: "T" });
    expect(await send(reply(503, {}))).toMatchObject({ ok: false, retryable: true, code: "http_503" });
    expect(await send(reply(429, {}))).toMatchObject({ ok: false, retryable: true });
    expect(await send(reply(400, { error: { code: 100 } }))).toMatchObject({ ok: false, retryable: false, code: "http_400" });
    expect(await send(reply(400, { error: { code: 190 } }))).toMatchObject({ ok: false, retryable: false, code: "auth" });
    expect(await send((async () => { throw new Error("boom tok-secret"); }) as unknown as typeof fetch)).toEqual({ ok: false, retryable: true, code: "network" });
  });
});
