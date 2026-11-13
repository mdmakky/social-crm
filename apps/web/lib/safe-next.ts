/**
 * Post-login redirect targets must be same-origin absolute paths. Rejects scheme-relative ("//x"),
 * backslash forms ("/\x", which browsers and URL parsers treat as "//x"), control characters and absolute URLs.
 */
export function safeNext(next: string | undefined | null, fallback = "/"): string {
  if (!next || next.length > 2048) return fallback;
  if (!/^\/(?![/\\])/.test(next)) return fallback;
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point of this check
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return fallback;
  try {
    const u = new URL(next, "http://placeholder.invalid");
    if (u.origin !== "http://placeholder.invalid") return fallback;
  } catch {
    return fallback;
  }
  return next;
}
