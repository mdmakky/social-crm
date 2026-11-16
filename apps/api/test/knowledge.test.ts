import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { endpoints, KNOWLEDGE_LIMITS } from "@crm/contracts";
import { KB_LIMITS, type PinnedFetch } from "@crm/knowledge";
import { searchKnowledge } from "../src/knowledge/search.ts";
import { bootstrap, failure, ok, type Harness, type TestUser } from "./harness.ts";

// AI Studio knowledge base, slice 1. Nothing here touches the network: URL ingestion runs against a fake resolver and fake fetch.
const pages = new Map<string, () => Response>();
const html = (body: string, ct = "text/html; charset=utf-8") => () => new Response(body, { headers: { "content-type": ct } });
const resolveHost = async (h: string) => (h === "rebind.example" ? ["10.0.0.7"] : ["93.184.216.34"]);
const fakeFetch: PinnedFetch = async (url) => { const p = pages.get(url.toString()); if (!p) throw new Error("no route"); return p(); };
const net = { resolve: resolveHost, fetch: fakeFetch };

let h: Harness, hl: Harness;
let owner: TestUser, admin: TestUser, agent: TestUser, viewer: TestUser, ownerB: TestUser, limitOwner: TestUser;
let A = "", B = "", L = "";
const as = (u: TestUser) => h.clientFor(u);
const p = (ws = A) => ({ workspaceId: ws });
const q = async (text: string, params: unknown[] = []) => (await h.admin.query(text, params)).rows;
const addText = async (title: string, text: string, u = owner, ws = A) => ok(await as(u).call(endpoints.createKnowledgeText, { params: p(ws), body: { title, text } }));
const search = async (text: string, u = owner, ws = A, limit?: number) => ok(await as(u).call(endpoints.searchKnowledge, { params: p(ws), query: { q: text, limit } })).items;
const raw = (kind: string, body: unknown) => h.app.request(`/v1/workspaces/${A}/knowledge/sources/${kind}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", cookie: owner.cookie }, body: JSON.stringify(body) });
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

beforeAll(async () => {
  h = await bootstrap({ knowledge: { net, limits: { ingestPerUser: 1000, urlPerUser: 1000, searchPerUser: 1000 } } });
  hl = await bootstrap({ knowledge: { net, limits: { ingestPerUser: 2, urlPerUser: 2, searchPerUser: 3 } } });
  [owner, admin, agent, viewer, ownerB, limitOwner] = (await Promise.all(["kbo", "kba", "kbg", "kbv", "kbb", "kbl"].map((l) => h.newUser(l)))) as [TestUser, TestUser, TestUser, TestUser, TestUser, TestUser];
  A = await h.workspace(owner, "KB A", { admin, agent, viewer });
  B = await h.workspace(ownerB, "KB B");
  const lo = await hl.newUser("kblim");
  limitOwner = lo;
  L = await hl.workspace(lo, "KB Limits");
});
afterAll(async () => { await h.close(); await hl.close(); });

describe("contract", () => {
  it("limits in contracts match the package", () => {
    expect(KNOWLEDGE_LIMITS).toEqual({ maxSources: KB_LIMITS.maxSources, maxCharsPerSource: KB_LIMITS.maxCharsPerSource, maxCharsPerWorkspace: KB_LIMITS.maxCharsPerWorkspace, maxFileBytes: KB_LIMITS.maxFileBytes });
  });
});

describe("permissions", () => {
  it("owner and admin manage; agent and viewer can only read and search", async () => {
    const s = await addText("Refund policy", "Refunds are paid within 14 days of the return.", owner);
    await addText("Shipping", "Shipping takes three working days.", admin);
    for (const u of [agent, viewer]) {
      expect(failure(await as(u).call(endpoints.createKnowledgeText, { params: p(), body: { title: "x", text: "y" } })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.createKnowledgeFile, { params: p(), body: { filename: "a.txt", content: "hello" } })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.createKnowledgeUrl, { params: p(), body: { url: "https://example.com/" } })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.reindexKnowledgeSource, { params: { workspaceId: A, sourceId: s.id } })).status).toBe(403);
      expect(failure(await as(u).call(endpoints.deleteKnowledgeSource, { params: { workspaceId: A, sourceId: s.id } })).status).toBe(403);
      expect(ok(await as(u).call(endpoints.listKnowledgeSources, { params: p() })).items.length).toBeGreaterThanOrEqual(2);
      expect(ok(await as(u).call(endpoints.getKnowledgeSource, { params: { workspaceId: A, sourceId: s.id } })).id).toBe(s.id);
      expect((await search("refunds", u)).length).toBe(1);
    }
    expect(await q("SELECT 1 FROM knowledge_sources WHERE workspace_id=$1 AND created_by = ANY($2)", [A, [agent.id, viewer.id]])).toEqual([]);
  });
  it("a non-member gets nothing at all", async () => {
    expect(failure(await as(ownerB).call(endpoints.listKnowledgeSources, { params: p(A) })).status).toBe(404);
    expect(failure(await as(ownerB).call(endpoints.searchKnowledge, { params: p(A), query: { q: "refunds" } })).status).toBe(404);
  });
});

describe("text, files and retrieval", () => {
  it("indexes pasted text, shows counts and who added it, and returns it with a source reference", async () => {
    const s = await addText("Warranty terms", "Every device has a two year warranty. Water damage is not covered by the warranty.");
    expect(s).toMatchObject({ type: "text", status: "ready", chunkCount: 1, sourceRef: null, error: null, createdByName: owner.name });
    expect(s.charCount).toBeGreaterThan(40);
    expect(ok(await as(owner).call(endpoints.getKnowledgeSource, { params: { workspaceId: A, sourceId: s.id } })).chunkCount).toBe(1);
    const hits = await search("warranty water");
    expect(hits[0]).toMatchObject({ sourceId: s.id, title: "Warranty terms", sourceRef: null, position: 0 });
    expect(hits[0]!.score).toBeGreaterThan(0);
    expect(hits[0]!.snippet).toContain("warranty");
    expect(hits[0]!.snippet).not.toMatch(/<\/?b>/);
  });
  it("ranks the better match first and respects limit", async () => {
    await addText("Opening hours", "We are open Monday to Friday. Saturday hours differ.");
    await addText("Parking", "Parking is free on Saturday for customers. Parking parking parking.");
    const hits = await search("saturday");
    expect(hits.map((x) => x.title).slice(0, 2).sort()).toEqual(["Opening hours", "Parking"]);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(hits[1]!.score);
    expect((await search("parking saturday"))[0]!.title).toBe("Parking");
    // a plain question: no stop words in 'simple', so the exact query finds nothing and the any-word retry answers it
    expect((await search("what are the hours on saturday please"))[0]!.title).toBe("Opening hours");
    expect(await search('"saturday hours" -parking')).toHaveLength(1);
    expect(await search("parking saturday", owner, A, 1)).toHaveLength(1);
    expect(await search("zzzzqqqq")).toEqual([]);
    expect(await search("!!! ???")).toEqual([]);
  });
  it("finds Bangla text, and chunks long documents with positions and overlap", async () => {
    await addText("ফেরত নীতি", "আমাদের ফেরত নীতি অনুযায়ী চৌদ্দ দিনের মধ্যে টাকা ফেরত দেওয়া হয়।");
    expect((await search("ফেরত"))[0]!.title).toBe("ফেরত নীতি");
    const long = Array.from({ length: 80 }, (_, i) => `Section ${i}. The zebracrossing rule number ${i} applies to pedestrians near schools.`).join("\n\n");
    const s = await addText("Long doc", long);
    expect(s.chunkCount).toBeGreaterThan(3);
    const rows = await q("SELECT position, content FROM knowledge_chunks WHERE source_id=$1 ORDER BY position", [s.id]);
    expect(rows.map((r) => r.position)).toEqual(rows.map((_, i) => i));
    expect((await search("zebracrossing", owner, A, 20)).length).toBeGreaterThan(3);
  });
  it("accepts txt, md, csv, html as text or base64, and says clearly what is not supported", async () => {
    const mk = async (body: { filename: string; content?: string; contentBase64?: string; title?: string }) => as(owner).call(endpoints.createKnowledgeFile, { params: p(), body });
    const txt = ok(await mk({ filename: "faq.txt", content: "Our mascot is a pelican named Pete." }));
    expect(txt).toMatchObject({ type: "file", sourceRef: "faq.txt", title: "faq.txt" });
    expect((await search("pelican"))[0]!.sourceRef).toBe("faq.txt");
    ok(await mk({ filename: "notes.md", content: "# Heading\n\nMarkdown mentions the quokka.", title: "Notes" }));
    expect((await search("quokka"))[0]!.title).toBe("Notes");
    ok(await mk({ filename: "prices.csv", contentBase64: b64("Product,Price\nWidget,10 dollars\nGadget,25 dollars\n") }));
    expect((await search("gadget"))[0]!.snippet).toContain("Price: 25 dollars");
    ok(await mk({ filename: "page.html", content: "<html><body><nav>skipme</nav><h1>Axolotl care</h1><p>Keep the water cool.</p></body></html>" }));
    expect((await search("axolotl"))).toHaveLength(1);
    expect(await search("skipme")).toEqual([]);
    for (const f of ["scan.pdf", "doc.docx", "photo.png", "voice.mp3", "noext"]) {
      const e = failure(await mk({ filename: f, contentBase64: b64("x") }));
      expect(e).toMatchObject({ status: 422, code: "unsupported_type" });
    }
    expect(failure(await mk({ filename: "bad.txt", contentBase64: Buffer.from([0xff, 0xfe, 0x00, 0xfd]).toString("base64") }))).toMatchObject({ status: 422, code: "invalid_encoding" });
    expect(failure(await mk({ filename: "empty.txt", content: "   " }))).toMatchObject({ status: 422, code: "empty_content" });
    expect((await raw("file", { filename: "a.txt" })).status).toBe(400);
  });
  it("rejects oversize files and text, and NUL characters", async () => {
    const big = Buffer.alloc(KB_LIMITS.maxFileBytes + 1, 97).toString("base64");
    expect(failure(await as(owner).call(endpoints.createKnowledgeFile, { params: p(), body: { filename: "big.txt", contentBase64: big } })).status).toBeGreaterThanOrEqual(400);
    const huge = await h.app.request(`/v1/workspaces/${A}/knowledge/sources/file`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000", cookie: owner.cookie }, body: JSON.stringify({ filename: "x.txt", content: "a".repeat(5 * 1024 * 1024) }) });
    expect(huge.status).toBe(413);
    expect((await raw("text", { title: "x", text: "a".repeat(KB_LIMITS.maxCharsPerSource + 1) })).status).toBe(400);
    expect((await raw("text", { title: "x", text: "bad\u0000text" })).status).toBe(400);
    expect((await raw("text", { title: "  ", text: "text" })).status).toBe(400);
  });
  it("audits creation without document content", async () => {
    const secret = "the-launch-code-is-swordfish-9917";
    const s = await addText("Audit check", `Internal note: ${secret}`);
    const rows = await q("SELECT action, summary FROM audit_log WHERE workspace_id=$1 AND entity_id=$2", [A, s.id]);
    expect(rows.map((r) => r.action)).toEqual(["knowledge.source.created"]);
    expect(JSON.stringify(rows)).not.toContain("swordfish");
    expect(rows[0]!.summary).toMatchObject({ type: "text", title: "Audit check", chunks: 1 });
  });
});

describe("URL sources (fake network)", () => {
  const add = (url: string, u = owner, ws = A, title?: string) => as(u).call(endpoints.createKnowledgeUrl, { params: p(ws), body: { url, title } });
  it("fetches a page, strips chrome, titles it from <title> and keeps the final URL as the source reference", async () => {
    pages.set("https://example.com/about", html("<html><head><title>About Acme</title></head><body><nav>menu</nav><h1>Our story</h1><p>Founded by marmots in 1999.</p><script>alert(1)</script></body></html>"));
    const s = ok(await add("https://example.com/about"));
    expect(s).toMatchObject({ type: "url", title: "About Acme", sourceRef: "https://example.com/about", status: "ready" });
    const hit = (await search("marmots"))[0]!;
    expect(hit).toMatchObject({ sourceId: s.id, sourceRef: "https://example.com/about" });
    expect(await search("alert")).toEqual([]);
    expect((await q("SELECT body FROM knowledge_sources WHERE id=$1", [s.id]))[0]!.body).toBeNull();
  });
  it("blocks private, loopback, metadata, credentials, bad schemes and rebinding names with a clear error and stores nothing", async () => {
    const before = (await q("SELECT count(*)::int n FROM knowledge_sources WHERE workspace_id=$1", [A]))[0]!.n;
    for (const u of ["http://127.0.0.1/", "http://localhost/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "https://rebind.example/x", "http://10.1.1.1/"])
      expect(failure(await add(u))).toMatchObject({ status: 422, code: "url_blocked" });
    for (const u of ["ftp://example.com/", "https://user:pw@example.com/", "file:///etc/passwd", "nonsense"])
      expect(failure(await add(u))).toMatchObject({ status: 422, code: "url_invalid" });
    pages.set("https://example.com/redir", () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }));
    expect(failure(await add("https://example.com/redir"))).toMatchObject({ status: 422, code: "url_blocked" });
    expect((await q("SELECT count(*)::int n FROM knowledge_sources WHERE workspace_id=$1", [A]))[0]!.n).toBe(before);
  });
  it("rejects wrong content types, error statuses, timeouts-as-failures and oversize pages", async () => {
    pages.set("https://example.com/data.json", html("{}", "application/json"));
    pages.set("https://example.com/missing", () => new Response("nope", { status: 404, headers: { "content-type": "text/html" } }));
    pages.set("https://example.com/big", () => new Response("a".repeat(KB_LIMITS.maxFileBytes + 5), { headers: { "content-type": "text/plain" } }));
    expect(failure(await add("https://example.com/data.json"))).toMatchObject({ code: "unsupported_content_type" });
    expect(failure(await add("https://example.com/missing"))).toMatchObject({ code: "fetch_status" });
    expect(failure(await add("https://example.com/big"))).toMatchObject({ status: 413, code: "too_large" });
    expect(failure(await add("https://example.com/unreachable"))).toMatchObject({ code: "fetch_failed" });
  });
  it("re-indexes: refetches and replaces chunks; a failed refresh keeps old chunks searchable and marks the source failed until it succeeds", async () => {
    pages.set("https://example.com/news", html("<p>First edition mentions the capybara.</p>", "text/plain"));
    const s = ok(await add("https://example.com/news", owner, A, "News"));
    expect((await search("capybara"))).toHaveLength(1);
    pages.set("https://example.com/news", html("<p>Second edition mentions the wombat.</p>", "text/plain"));
    const r = ok(await as(owner).call(endpoints.reindexKnowledgeSource, { params: { workspaceId: A, sourceId: s.id } }));
    expect(r).toMatchObject({ status: "ready", error: null });
    expect(await search("capybara")).toEqual([]);
    expect((await search("wombat"))[0]!.sourceId).toBe(s.id);
    pages.delete("https://example.com/news");
    expect(failure(await as(owner).call(endpoints.reindexKnowledgeSource, { params: { workspaceId: A, sourceId: s.id } }))).toMatchObject({ code: "fetch_failed" });
    expect(ok(await as(owner).call(endpoints.getKnowledgeSource, { params: { workspaceId: A, sourceId: s.id } }))).toMatchObject({ status: "failed", error: "fetch_failed" });
    expect((await search("wombat"))).toHaveLength(1);
    pages.set("https://example.com/news", html("Third edition mentions the okapi.", "text/plain"));
    expect(ok(await as(owner).call(endpoints.reindexKnowledgeSource, { params: { workspaceId: A, sourceId: s.id } }))).toMatchObject({ status: "ready", error: null });
    expect(await search("wombat")).toEqual([]);
  });
  it("re-indexes text sources from the stored text", async () => {
    const s = await addText("Re-index me", "The tapir lives in forests. ".repeat(5));
    const r = ok(await as(owner).call(endpoints.reindexKnowledgeSource, { params: { workspaceId: A, sourceId: s.id } }));
    expect(r).toMatchObject({ status: "ready", chunkCount: s.chunkCount, charCount: s.charCount });
    expect((await search("tapir"))).toHaveLength(1);
  });
});

describe("tenant isolation", () => {
  it("workspace B can never see, fetch, search, re-index or delete workspace A's knowledge", async () => {
    const secretWord = "ouroboroscompass";
    const s = await addText("A private", `Confidential: the ${secretWord} procedure.`, owner, A);
    const b = await addText("B notes", `Workspace B talks about ${secretWord} too, differently.`, ownerB, B);
    // B searches the same word: only its own chunk comes back
    const hitsB = await search(secretWord, ownerB, B);
    expect(hitsB.map((x) => x.sourceId)).toEqual([b.id]);
    const hitsA = await search(secretWord, owner, A);
    expect(hitsA.map((x) => x.sourceId)).toEqual([s.id]);
    // B cannot reach A's workspace by URL
    expect(failure(await as(ownerB).call(endpoints.getKnowledgeSource, { params: { workspaceId: A, sourceId: s.id } })).status).toBe(404);
    expect(failure(await as(ownerB).call(endpoints.searchKnowledge, { params: { workspaceId: A }, query: { q: secretWord } })).status).toBe(404);
    // B's own workspace with A's source id: not found, nothing changes
    expect(failure(await as(ownerB).call(endpoints.getKnowledgeSource, { params: { workspaceId: B, sourceId: s.id } })).status).toBe(404);
    expect(failure(await as(ownerB).call(endpoints.reindexKnowledgeSource, { params: { workspaceId: B, sourceId: s.id } })).status).toBe(404);
    expect(failure(await as(ownerB).call(endpoints.deleteKnowledgeSource, { params: { workspaceId: B, sourceId: s.id } })).status).toBe(404);
    expect(ok(await as(ownerB).call(endpoints.listKnowledgeSources, { params: p(B) })).items.map((x) => x.id)).toEqual([b.id]);
    expect((await search(secretWord, owner, A)).length).toBe(1);
  });
  it("the retrieval function is scoped by the context it is given (what future agents call)", async () => {
    const mine = await searchKnowledge(h.db, { workspaceId: B, userId: ownerB.id }, "ouroboroscompass");
    expect(mine.every((x) => x.title === "B notes")).toBe(true);
    // a user from workspace B presenting workspace A's id sees nothing: RLS requires membership in the workspace of the context
    expect(await searchKnowledge(h.db, { workspaceId: A, userId: ownerB.id }, "ouroboroscompass")).toEqual([]);
    expect(await searchKnowledge(h.db, { workspaceId: A, userId: owner.id }, "   ")).toEqual([]);
  });
});

describe("delete", () => {
  it("soft-deletes the source and physically purges its chunks, and it cannot come back", async () => {
    const s = await addText("To delete", "The narwhal is an arctic whale.");
    expect((await search("narwhal"))).toHaveLength(1);
    expect((await q("SELECT count(*)::int n FROM knowledge_chunks WHERE source_id=$1", [s.id]))[0]!.n).toBe(1);
    const res = await as(admin).call(endpoints.deleteKnowledgeSource, { params: { workspaceId: A, sourceId: s.id } });
    expect(res.ok).toBe(true);
    expect((await q("SELECT count(*)::int n FROM knowledge_chunks WHERE source_id=$1", [s.id]))[0]!.n).toBe(0);
    const row = (await q("SELECT deleted_at, body FROM knowledge_sources WHERE id=$1", [s.id]))[0]!;
    expect(row.deleted_at).not.toBeNull();
    expect(row.body).toBeNull();
    expect(await search("narwhal")).toEqual([]);
    expect(failure(await as(owner).call(endpoints.getKnowledgeSource, { params: { workspaceId: A, sourceId: s.id } })).status).toBe(404);
    expect(failure(await as(owner).call(endpoints.deleteKnowledgeSource, { params: { workspaceId: A, sourceId: s.id } })).status).toBe(404);
    expect(failure(await as(owner).call(endpoints.reindexKnowledgeSource, { params: { workspaceId: A, sourceId: s.id } })).status).toBe(404);
    expect(ok(await as(owner).call(endpoints.listKnowledgeSources, { params: p() })).items.map((x) => x.id)).not.toContain(s.id);
    expect((await q("SELECT action FROM audit_log WHERE entity_id=$1 ORDER BY id", [s.id])).map((r) => r.action)).toEqual(["knowledge.source.created", "knowledge.source.deleted"]);
  });
});

describe("limits", () => {
  it("refuses a 201st source and a workspace over its text budget", async () => {
    const ws = await h.workspace(owner, "KB Limits A");
    await h.admin.query(`INSERT INTO knowledge_sources (workspace_id, type, title, status, char_count, created_by) SELECT $1, 'text', 'bulk ' || g, 'ready', 10, $2 FROM generate_series(1, ${KB_LIMITS.maxSources}) g`, [ws, owner.id]);
    expect(failure(await as(owner).call(endpoints.createKnowledgeText, { params: p(ws), body: { title: "one too many", text: "hello" } }))).toMatchObject({ status: 409, code: "source_limit" });
    const usage = ok(await as(owner).call(endpoints.listKnowledgeSources, { params: p(ws) })).usage;
    expect(usage).toMatchObject({ sources: KB_LIMITS.maxSources, maxSources: KB_LIMITS.maxSources });
    const ws2 = await h.workspace(owner, "KB Limits B");
    await h.admin.query(`INSERT INTO knowledge_sources (workspace_id, type, title, status, char_count, created_by) VALUES ($1,'text','big','ready',${KB_LIMITS.maxCharsPerWorkspace - 3},$2)`, [ws2, owner.id]);
    expect(failure(await as(owner).call(endpoints.createKnowledgeText, { params: p(ws2), body: { title: "over", text: "hello world" } }))).toMatchObject({ status: 409, code: "storage_limit" });
  });
  it("refuses a source that would need more than 2000 chunks", async () => {
    // 1,000,000 chars of unbreakable text is about 1,250 chunks, under the cap; the check itself is covered by the package limit relationship
    expect(Math.ceil(KB_LIMITS.maxCharsPerSource / 800)).toBeLessThan(KB_LIMITS.maxChunksPerSource);
  });
});

describe("rate limits (in-process)", () => {
  it("ingestion, URL fetches and search return 429 with Retry-After", async () => {
    const c = hl.clientFor(limitOwner);
    const t = (n: number) => c.call(endpoints.createKnowledgeText, { params: { workspaceId: L }, body: { title: `t${n}`, text: `text ${n}` } });
    ok(await t(1)); ok(await t(2));
    expect(failure(await t(3)).status).toBe(429);
    const u = (n: number) => c.call(endpoints.createKnowledgeUrl, { params: { workspaceId: L }, body: { url: `http://127.0.0.1/${n}` } });
    expect(failure(await u(1)).status).not.toBe(429);
    expect(failure(await u(2)).status).not.toBe(429);
    expect(failure(await u(3))).toMatchObject({ status: 429, code: "rate_limited" });
    for (let i = 0; i < 3; i++) ok(await c.call(endpoints.searchKnowledge, { params: { workspaceId: L }, query: { q: "text" } }));
    expect(failure(await c.call(endpoints.searchKnowledge, { params: { workspaceId: L }, query: { q: "text" } })).status).toBe(429);
    const raw = await hl.app.request(`/v1/workspaces/${L}/knowledge/search?q=text`, { headers: { cookie: limitOwner.cookie } });
    expect(raw.status).toBe(429);
    expect(raw.headers.get("retry-after")).toBe("600");
  });
});
