/** A redirect target is allowed when it is a same-site path or an absolute URL on one of our own origins. */
export function isAllowedRedirect(target: unknown, allowedOrigins: string[]): boolean {
  if (typeof target !== "string" || target.length === 0 || target.length > 2048) return false;
  // eslint-disable-next-line no-control-regex -- rejecting control characters and backslashes is the point
  if (/[\u0000-\u001f\u007f\\]/.test(target)) return false;
  if (target.startsWith("/")) return !target.startsWith("//");
  try {
    return allowedOrigins.includes(new URL(target).origin);
  } catch {
    return false;
  }
}
