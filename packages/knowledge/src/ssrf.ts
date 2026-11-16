import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { KB_LIMITS, KnowledgeError } from "./text.ts";

/**
 * Fetching a customer-supplied URL from our servers is an SSRF risk: the URL must never reach our private network, cloud metadata or loopback.
 * Defences, in order: http(s) only, no credentials in the URL, only ports 80/443/8080/8443, every address the name resolves to is checked (one private address
 * rejects the whole name, so a mixed DNS answer cannot slip through), the connection is made to the address that was checked (the socket's own lookup, so DNS
 * cannot change between check and connect), and every redirect goes through the same checks again (at most 3). Timeout, size and content type are bounded.
 */

export function ipv4Parts(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((x) => x <= 255) ? p : null;
}

/** Eight 16-bit groups, or null. Handles "::" and a dotted IPv4 tail. */
export function ipv6Groups(input: string): number[] | null {
  let s = input.toLowerCase();
  if (s.includes("%")) return null; // zone ids are not valid for a remote host
  const dot = s.lastIndexOf(":");
  if (s.includes(".")) {
    const v4 = ipv4Parts(s.slice(dot + 1));
    if (!v4) return null;
    s = `${s.slice(0, dot + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h: string) => (h === "" ? [] : h.split(":"));
  const head = parse(halves[0]!), tail = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

function blockedV4([a, b, c]: number[]): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a! >= 224 ||             // "this" network, private, loopback, multicast and reserved (incl. 255.255.255.255)
    (a === 100 && b! >= 64 && b! <= 127) ||                      // carrier-grade NAT (also Alibaba metadata 100.100.100.200)
    (a === 169 && b === 254) ||                                  // link-local, includes cloud metadata 169.254.169.254
    (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||                     // benchmarking
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) // documentation
  );
}

/** True when the address must never be fetched: loopback, private, link-local, metadata, multicast, reserved, and IPv6 forms that embed such an IPv4. Unparseable input is blocked. */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return blockedV4(ipv4Parts(ip)!);
  if (kind !== 6) return true;
  const g = ipv6Groups(ip);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => blockedV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return g[5] === 0xffff ? embedded(g[6]!, g[7]!) : true; // ::ffff:a.b.c.d (mapped); ::, ::1, ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return embedded(g[6]!, g[7]!); // NAT64 64:ff9b::/96
  if (g[0] === 0x2002) return embedded(g[1]!, g[2]!); // 6to4
  return (
    (g[0]! & 0xfe00) === 0xfc00 ||                                // fc00::/7 unique local (includes fd00:ec2::254 metadata)
    (g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xffc0) === 0xfec0 || // link-local, site-local
    (g[0]! & 0xff00) === 0xff00 ||                                // multicast
    (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) ||        // Teredo, documentation
    (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0)    // discard-only
  );
}

export type Resolver = (hostname: string) => Promise<string[]>;
export type PinnedFetch = (url: URL, init: { address: string; signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;
export type SafeFetchDeps = { resolve?: Resolver; fetch?: PinnedFetch };
export type Fetched = { text: string; contentType: string; finalUrl: string };

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);
const ALLOWED_TYPES = new Set(["text/html", "text/plain", "text/markdown"]);
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;

const defaultResolve: Resolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Real network: connects to `address` (already checked) while still sending the hostname for TLS and Host. Never follows redirects itself. */
const defaultFetch: PinnedFetch = (url, { address, signal, headers }) =>
  new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(url, {
      method: "GET", headers, signal, agent: false,
      lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [{ address, family: isIP(address) }]) : cb(null, address, isIP(address)))) as never,
    }, (res) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(", ") : v);
      const status = res.statusCode ?? 0;
      resolve(new Response([204, 205, 304].includes(status) ? null : (Readable.toWeb(res) as ReadableStream), { status, headers: h }));
    });
    req.on("error", reject);
    req.end();
  });

/** Checks a URL string and resolves its host. Returns the parsed URL and the address to connect to. Throws KnowledgeError url_invalid / url_blocked. */
export async function assertPublicUrl(raw: string, resolve: Resolver = defaultResolve): Promise<{ url: URL; address: string }> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new KnowledgeError("url_invalid", "This is not a valid web address."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new KnowledgeError("url_invalid", "Only http and https addresses are supported.");
  if (url.username || url.password) throw new KnowledgeError("url_invalid", "Addresses with a user name or password are not supported.");
  if (!ALLOWED_PORTS.has(url.port)) throw new KnowledgeError("url_blocked", "This address uses a port that is not allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new KnowledgeError("url_blocked", "This address points to a private or internal network and cannot be used.");
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try { addresses = await resolve(host); } catch { throw new KnowledgeError("fetch_failed", "The address could not be reached."); }
  }
  if (!addresses.length) throw new KnowledgeError("fetch_failed", "The address could not be reached.");
  if (addresses.some(isBlockedIp)) throw new KnowledgeError("url_blocked", "This address points to a private or internal network and cannot be used.");
  return { url, address: addresses[0]! };
}

/** Reads at most `max` bytes; cancels the stream and fails as soon as it is exceeded. */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) { await res.body?.cancel().catch(() => {}); throw new KnowledgeError("too_large", "The page is larger than 2 MB."); }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw new KnowledgeError("too_large", "The page is larger than 2 MB."); }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

/** Fetches one public page (HTML, plain text or markdown) with the protections described at the top of this file. Injectable resolver and fetch keep tests off the network. */
export async function fetchPublicPage(raw: string, deps: SafeFetchDeps = {}): Promise<Fetched> {
  const resolve = deps.resolve ?? defaultResolve;
  const doFetch = deps.fetch ?? defaultFetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let next = raw;
    for (let hop = 0; ; hop++) {
      const { url, address } = await assertPublicUrl(next, resolve);
      const res = await doFetch(url, { address, signal: ctl.signal, headers: { "user-agent": "SocialCRM-KnowledgeBot/1.0", accept: "text/html,text/plain,text/markdown;q=0.9", "accept-encoding": "identity" } });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) throw new KnowledgeError("too_many_redirects", "The address redirects too many times.");
        try { next = new URL(res.headers.get("location")!, url).toString(); } catch { throw new KnowledgeError("url_invalid", "The address redirects to an invalid address."); }
        continue;
      }
      if (res.status < 200 || res.status >= 300) { await res.body?.cancel().catch(() => {}); throw new KnowledgeError("fetch_status", `The website answered with status ${res.status}.`); }
      const ct = res.headers.get("content-type") ?? "";
      const type = ct.split(";")[0]!.trim().toLowerCase();
      if (!ALLOWED_TYPES.has(type)) { await res.body?.cancel().catch(() => {}); throw new KnowledgeError("unsupported_content_type", "Only web pages, plain text and markdown can be added from an address."); }
      const bytes = await readCapped(res, KB_LIMITS.maxFileBytes);
      const charset = /charset=["']?([\w-]+)/i.exec(ct)?.[1] ?? "utf-8";
      let text: string;
      try { text = new TextDecoder(charset).decode(bytes); } catch { text = new TextDecoder("utf-8").decode(bytes); }
      return { text, contentType: type, finalUrl: url.toString() };
    }
  } catch (e) {
    if (e instanceof KnowledgeError) throw e;
    if (ctl.signal.aborted) throw new KnowledgeError("fetch_timeout", "The website took too long to answer.");
    throw new KnowledgeError("fetch_failed", "The address could not be reached.");
  } finally {
    clearTimeout(timer);
  }
}
