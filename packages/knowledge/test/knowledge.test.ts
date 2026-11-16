import { describe, expect, it } from "vitest";
import { assertPublicUrl, chunkText, CHUNK_DEFAULTS, extractFile, extractors, fetchPublicPage, htmlToText, isBlockedIp, KnowledgeError, normalizeText, prepareSource, type PinnedFetch } from "../src/index.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const code = async (p: Promise<unknown>) => { try { await p; return "ok"; } catch (e) { return e instanceof KnowledgeError ? e.code : `other:${String(e)}`; } };

describe("normalizeText", () => {
  it("cleans line ends, controls, spaces and blank lines", () => {
    expect(normalizeText("  a\r\nb\u0000​  c \t d\n\n\n\n e\r")).toBe("a\nb c d\n\ne");
  });
  it("repairs lone surrogates and composes (NFC)", () => {
    expect(normalizeText("x\uD800y")).toBe("x�y");
    expect(normalizeText("é")).toBe("é");
  });
});

describe("chunkText", () => {
  const sample = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} says that refunds are paid within ${i + 3} days. Contact support for help. It also mentions shipping.`).join("\n\n");
  it("is deterministic with stable positions", () => {
    const a = chunkText(sample), b = chunkText(sample);
    expect(a).toEqual(b);
    expect(a.map((c) => c.position)).toEqual(a.map((_, i) => i));
    expect(a.length).toBeGreaterThan(5);
  });
  it("never exceeds the hard maximum and starts later chunks with overlap from the previous one", () => {
    const chunks = chunkText(sample);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(CHUNK_DEFAULTS.max);
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = chunks[i - 1]!.content.split(/\s+/).slice(-3).join(" ");
      expect(chunks[i]!.content.slice(0, 160)).toContain(prevTail.split(" ").slice(-1)[0]);
    }
  });
  it("splits long text without punctuation or spaces and keeps every chunk under the maximum", () => {
    const blob = "x".repeat(5000);
    const chunks = chunkText(blob);
    expect(chunks.length).toBeGreaterThanOrEqual(6);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(CHUNK_DEFAULTS.max);
  });
  it("splits Bangla at the danda and CJK at full stops, never in the middle of a character", () => {
    const bn = Array.from({ length: 80 }, (_, i) => `আমাদের ফেরত নীতি ${i} দিনের মধ্যে প্রযোজ্য।`).join(" ");
    const zh = Array.from({ length: 120 }, (_, i) => `退款将在${i}个工作日内处理。`).join("");
    const emoji = "😀".repeat(1500);
    for (const text of [bn, zh, emoji]) {
      const chunks = chunkText(text);
      expect(chunks.length).toBeGreaterThan(1);
      for (const c of chunks) {
        expect(c.content.length).toBeLessThanOrEqual(CHUNK_DEFAULTS.max);
        expect(() => encodeURIComponent(c.content)).not.toThrow(); // throws on a split surrogate pair
      }
    }
    expect(chunkText(bn)[0]!.content.trimEnd().endsWith("।")).toBe(true);
    expect(chunkText(zh)[0]!.content.endsWith("。")).toBe(true);
  });
  it("keeps short text as one chunk and gives no chunk for empty text", () => {
    expect(chunkText("Hello world.")).toEqual([{ position: 0, content: "Hello world.", tokenEstimate: 3 }]);
    expect(chunkText("")).toEqual([]);
  });
  it("rejects options that cannot satisfy the maximum", () => {
    expect(() => chunkText("a", { target: 800, overlap: 500, max: 1000 })).toThrow(RangeError);
  });
  it("does not cut a decimal number as a sentence end", () => {
    const t = `Price is 3.14 dollars. ${"filler words go here and there. ".repeat(40)}`;
    expect(chunkText(t)[0]!.content.startsWith("Price is 3.14 dollars.")).toBe(true);
  });
});

describe("htmlToText", () => {
  const page = `<!doctype html><html><head><title>Acme &amp; Co</title><style>.a{color:red}</style><script>var secret = 1 < 2;</script></head>
  <body><nav><a href="/">Home</a><a href="/x">Pricing menu</a></nav><h1>Returns</h1><p>We accept returns&nbsp;within <b>30</b> days &#8212; no questions.</p>
  <ul><li>Keep the box</li><li>Bring receipt</li></ul><!-- hidden comment --><h2>Shipping</h2><p>Free over &#x24;50.</p><footer>Copyright junk</footer></body></html>`;
  it("keeps headings and text, drops scripts, styles, nav, footer and comments", () => {
    const { title, text } = htmlToText(page);
    expect(title).toBe("Acme & Co");
    expect(text).toContain("# Returns");
    expect(text).toContain("We accept returns within 30 days — no questions.");
    expect(text).toContain("- Keep the box\n- Bring receipt");
    expect(text).toContain("## Shipping");
    expect(text).toContain("Free over $50.");
    for (const bad of ["secret", "color:red", "Pricing menu", "hidden comment", "Copyright", "Acme"]) expect(text).not.toContain(bad);
  });
  it("survives hostile input quickly (unclosed script, many '<', huge page)", () => {
    const t0 = Date.now();
    htmlToText("<p>ok</p>" + "<script>".repeat(50_000));
    htmlToText("<".repeat(200_000) + "<div".repeat(100_000));
    htmlToText("<p>x</p>".repeat(100_000));
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(htmlToText("<p>keep</p><script>drop").text).toBe("keep");
  });
});

describe("extractFile", () => {
  it("reads txt, md, csv and html", async () => {
    expect((await extractFile({ filename: "a.TXT", bytes: enc("Hello\r\nworld") })).text).toBe("Hello\nworld");
    expect((await extractFile({ filename: "a.md", bytes: enc("# T\n\nbody") })).text).toBe("# T\n\nbody");
    expect((await extractFile({ filename: "a.csv", bytes: enc("Name,Plan\nAnna,Pro\nBen,\n") })).text).toBe("Name: Anna; Plan: Pro\n\nName: Ben");
    expect((await extractFile({ filename: "a.html", bytes: enc("<h1>Hi</h1><p>there</p>") })).text).toBe("# Hi\n\nthere");
  });
  it("returns unsupported_type for formats coming in later slices, and for no extension", async () => {
    for (const f of ["a.pdf", "a.docx", "a.png", "a.mp3", "noext", "a.constructor", ".txt.exe"]) expect(await code(extractFile({ filename: f, bytes: enc("x") }))).toBe("unsupported_type");
  });
  it("rejects invalid UTF-8, empty files and oversize files", async () => {
    expect(await code(extractFile({ filename: "a.txt", bytes: new Uint8Array([0xff, 0xfe, 0xfd]) }))).toBe("invalid_encoding");
    expect(await code(extractFile({ filename: "a.txt", bytes: enc("  \n ") }))).toBe("empty_content");
    expect(await code(extractFile({ filename: "a.txt", bytes: new Uint8Array(2 * 1024 * 1024 + 1) }))).toBe("too_large");
  });
  it("lets a later slice register an extractor", async () => {
    extractors[".fake"] = () => ({ text: "from plugin" });
    expect((await extractFile({ filename: "x.fake", bytes: enc("") })).text).toBe("from plugin");
    delete extractors[".fake"];
  });
  it("prepareSource enforces per-source limits", () => {
    expect(() => prepareSource("   ")).toThrow(KnowledgeError);
    expect(prepareSource("Hello there.").chunks).toHaveLength(1);
  });
});

describe("isBlockedIp", () => {
  it.each([
    "0.0.0.0", "10.1.2.3", "127.0.0.1", "127.255.255.254", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.100.100.200",
    "192.0.2.5", "198.18.0.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fe80::1", "fc00::1", "fd00:ec2::254", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "64:ff9b::7f00:1", "2002:7f00:1::1", "::127.0.0.1", "not-an-ip", "fe80::1%eth0",
  ])("blocks %s", (ip) => expect(isBlockedIp(ip)).toBe(true));
  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "172.15.0.1", "100.63.0.1", "2606:4700:4700::1111", "2a00:1450:4009:81f::200e", "::ffff:8.8.8.8"])("allows %s", (ip) => expect(isBlockedIp(ip)).toBe(false));
});

const page = (body: string, init: ResponseInit = { headers: { "content-type": "text/html; charset=utf-8" } }) => new Response(body, init);
const PUBLIC = async () => ["93.184.216.34"];
const calls: string[] = [];
const fakeFetch = (routes: Record<string, () => Response>): PinnedFetch => async (url, init) => {
  calls.push(`${url.toString()}@${init.address}`);
  const r = routes[url.toString()];
  if (!r) throw new Error("no route");
  return r();
};

describe("assertPublicUrl and fetchPublicPage (SSRF guard, no network)", () => {
  it("rejects bad schemes, credentials, odd ports and internal names before any DNS", async () => {
    let resolved = 0;
    const resolve = async () => { resolved++; return ["93.184.216.34"]; };
    expect(await code(assertPublicUrl("ftp://example.com/x", resolve))).toBe("url_invalid");
    expect(await code(assertPublicUrl("file:///etc/passwd", resolve))).toBe("url_invalid");
    expect(await code(assertPublicUrl("javascript:alert(1)", resolve))).toBe("url_invalid");
    expect(await code(assertPublicUrl("not a url", resolve))).toBe("url_invalid");
    expect(await code(assertPublicUrl("https://user:pw@example.com/", resolve))).toBe("url_invalid");
    expect(await code(assertPublicUrl("https://user@example.com/", resolve))).toBe("url_invalid");
    expect(await code(assertPublicUrl("https://example.com:22/", resolve))).toBe("url_blocked");
    expect(await code(assertPublicUrl("http://localhost/", resolve))).toBe("url_blocked");
    expect(await code(assertPublicUrl("http://app.localhost/", resolve))).toBe("url_blocked");
    expect(await code(assertPublicUrl("http://db.internal/", resolve))).toBe("url_blocked");
    expect(resolved).toBe(0);
  });
  it("blocks private and loopback IP literals in every spelling the URL parser normalises", async () => {
    for (const u of ["http://127.0.0.1/", "http://10.0.0.5/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://[fd00:ec2::254]/", "http://[::ffff:7f00:1]/", "http://2130706433/", "http://0x7f.1/", "http://0177.0.0.1/", "http://127.1/", "http://0/", "http://[::ffff:169.254.169.254]/"])
      expect(await code(assertPublicUrl(u, PUBLIC))).toBe("url_blocked");
  });
  it("blocks a name whose DNS answer is private, including a mixed answer (rebinding style)", async () => {
    expect(await code(assertPublicUrl("https://evil.example/", async () => ["10.0.0.1"]))).toBe("url_blocked");
    expect(await code(assertPublicUrl("https://evil.example/", async () => ["93.184.216.34", "127.0.0.1"]))).toBe("url_blocked");
    expect(await code(assertPublicUrl("https://evil.example/", async () => ["2606:4700::1", "::1"]))).toBe("url_blocked");
    expect(await code(assertPublicUrl("https://evil.example/", async () => []))).toBe("fetch_failed");
    expect(await code(assertPublicUrl("https://evil.example/", async () => { throw new Error("ENOTFOUND"); }))).toBe("fetch_failed");
  });
  it("fetches a public page and connects to the address that was checked", async () => {
    calls.length = 0;
    const out = await fetchPublicPage("https://example.com/a", { resolve: PUBLIC, fetch: fakeFetch({ "https://example.com/a": () => page("<h1>Hi</h1>") }) });
    expect(out).toMatchObject({ text: "<h1>Hi</h1>", contentType: "text/html", finalUrl: "https://example.com/a" });
    expect(calls).toEqual(["https://example.com/a@93.184.216.34"]);
  });
  it("follows redirects through the same checks and stops at 3", async () => {
    const go = (loc: string) => () => new Response(null, { status: 302, headers: { location: loc } });
    const ok = await fetchPublicPage("https://example.com/1", { resolve: PUBLIC, fetch: fakeFetch({ "https://example.com/1": go("/2"), "https://example.com/2": go("https://example.com/3"), "https://example.com/3": go("/4"), "https://example.com/4": () => page("done") }) });
    expect(ok.finalUrl).toBe("https://example.com/4");
    const four = fakeFetch({ "https://example.com/1": go("/2"), "https://example.com/2": go("/3"), "https://example.com/3": go("/4"), "https://example.com/4": go("/5"), "https://example.com/5": () => page("x") });
    expect(await code(fetchPublicPage("https://example.com/1", { resolve: PUBLIC, fetch: four }))).toBe("too_many_redirects");
  });
  it("blocks a redirect to a private address, to metadata, to a non-http scheme and to a name that resolves privately", async () => {
    for (const loc of ["http://127.0.0.1/admin", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "file:///etc/passwd", "https://user:pw@example.com/", "https://rebind.example/x"]) {
      const resolve = async (h: string) => (h === "rebind.example" ? ["192.168.0.10"] : ["93.184.216.34"]);
      const f = fakeFetch({ "https://example.com/start": () => new Response(null, { status: 301, headers: { location: loc } }) });
      expect(["url_blocked", "url_invalid"]).toContain(await code(fetchPublicPage("https://example.com/start", { resolve, fetch: f })));
    }
  });
  it("rejects wrong content types, missing content type and error statuses", async () => {
    for (const ct of ["application/json", "application/pdf", "image/png", "application/octet-stream"])
      expect(await code(fetchPublicPage("https://example.com/a", { resolve: PUBLIC, fetch: fakeFetch({ "https://example.com/a": () => page("x", { headers: { "content-type": ct } }) }) }))).toBe("unsupported_content_type");
    expect(await code(fetchPublicPage("https://example.com/a", { resolve: PUBLIC, fetch: fakeFetch({ "https://example.com/a": () => new Response(null) }) }))).toBe("unsupported_content_type");
    expect(await code(fetchPublicPage("https://example.com/a", { resolve: PUBLIC, fetch: fakeFetch({ "https://example.com/a": () => page("nope", { status: 404, headers: { "content-type": "text/html" } }) }) }))).toBe("fetch_status");
    for (const ct of ["text/plain", "text/markdown; charset=utf-8", "TEXT/HTML"]) expect((await fetchPublicPage("https://example.com/a", { resolve: PUBLIC, fetch: fakeFetch({ "https://example.com/a": () => page("ok", { headers: { "content-type": ct } }) }) })).text).toBe("ok");
  });
  it("rejects a body over 2 MB, declared or streamed", async () => {
    const big = "a".repeat(2 * 1024 * 1024 + 1);
    expect(await code(fetchPublicPage("https://example.com/a", { resolve: PUBLIC, fetch: fakeFetch({ "https://example.com/a": () => page(big, { headers: { "content-type": "text/plain", "content-length": String(big.length) } }) }) }))).toBe("too_large");
    const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(512 * 1024)); } }); // endless, no content-length
    expect(await code(fetchPublicPage("https://example.com/a", { resolve: PUBLIC, fetch: fakeFetch({ "https://example.com/a": () => new Response(stream, { headers: { "content-type": "text/plain" } }) }) }))).toBe("too_large");
  });
  it("times out after 10 seconds", async () => {
    const hang: PinnedFetch = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    const t0 = Date.now();
    expect(await code(fetchPublicPage("https://example.com/a", { resolve: PUBLIC, fetch: hang }))).toBe("fetch_timeout");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(9_500);
  }, 15_000);
  it("maps network failures to fetch_failed without leaking the cause", async () => {
    expect(await code(fetchPublicPage("https://example.com/a", { resolve: PUBLIC, fetch: async () => { throw new Error("ECONNREFUSED 10.0.0.1:443"); } }))).toBe("fetch_failed");
  });
});
