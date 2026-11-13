// Reports which prerequisites for the REAL Meta test are missing. Prints variable NAMES only, never values.
// Usage (from apps/api):  pnpm exec tsx --env-file-if-exists=../../.env dev/meta-preflight.mts [--graph]
// --graph makes ONE real call to Meta: debug_token on the app's own access token, to prove App ID + Secret are valid.
import { existsSync, readFileSync } from "node:fs";
import { createMetaGraph } from "@crm/integrations";

const need: [string, string][] = [
  ["BETTER_AUTH_SECRET", "at least 32 chars (the .env.example placeholder is too short)"],
  ["DATABASE_URL_APP", "crm_app connection"], ["DATABASE_URL_INGEST", "crm_ingest connection"], ["DATABASE_URL_WORKER", "crm_worker connection"],
  ["META_APP_ID", "Meta app dashboard > App settings > Basic"], ["META_APP_SECRET", "same page (server-side only)"], ["META_VERIFY_TOKEN", "any random string you choose (8+ chars)"],
  ["META_FLFB_CONFIG_ID", "Facebook Login for Business > Configurations"], ["SECRETS_ENCRYPTION_KEY", "openssl rand -base64 32"], ["META_PUBLIC_BASE_URL", "tunnel URL from scripts/dev-tunnel/start.sh (for the data-deletion status link)"],
];
const env = process.env;
const problems: string[] = [];
for (const [name, hint] of need) {
  const v = env[name];
  if (!v) problems.push(`MISSING  ${name}  (${hint})`);
}
if (env.BETTER_AUTH_SECRET && env.BETTER_AUTH_SECRET.length < 32) problems.push("INVALID  BETTER_AUTH_SECRET is shorter than 32 characters");
if (env.SECRETS_ENCRYPTION_KEY && Buffer.from(env.SECRETS_ENCRYPTION_KEY, "base64").length !== 32) problems.push("INVALID  SECRETS_ENCRYPTION_KEY must be 32 bytes, base64");
if (env.META_MOCK === "1") problems.push("WARNING  META_MOCK=1 is set: connect would use the MOCK Graph, not Meta");
const tunnelFile = new URL("../../../.dev-tunnel/url", import.meta.url);
const tunnel = existsSync(tunnelFile) ? readFileSync(tunnelFile, "utf8").trim() : null;
if (!tunnel) problems.push("MISSING  running tunnel: run scripts/dev-tunnel/start.sh");
else if (env.META_PUBLIC_BASE_URL && env.META_PUBLIC_BASE_URL.replace(/\/$/, "") !== tunnel) problems.push(`MISMATCH META_PUBLIC_BASE_URL is not the current tunnel URL (${tunnel}); the URL changes on every start`);

if (tunnel && env.META_VERIFY_TOKEN) {
  try {
    const r = await fetch(`${tunnel}/webhooks/meta/messenger?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(env.META_VERIFY_TOKEN)}&hub.challenge=777`, { signal: AbortSignal.timeout(8000) });
    if (r.status !== 200 || (await r.text()) !== "777") problems.push(`FAIL     webhook handshake through the tunnel answered ${r.status} (is the API running with the same META_VERIFY_TOKEN?)`);
    else console.log("ok       webhook handshake through the tunnel");
  } catch {
    problems.push("FAIL     tunnel not reachable");
  }
}
if (process.argv.includes("--graph") && env.META_APP_ID && env.META_APP_SECRET) {
  const g = createMetaGraph({ appId: env.META_APP_ID, appSecret: env.META_APP_SECRET, version: env.META_GRAPH_VERSION ?? "v25.0" });
  try {
    const info = await g.debugToken(`${env.META_APP_ID}|${env.META_APP_SECRET}`);
    if (info.isValid) console.log("ok       REAL Meta call: App ID and App Secret are valid (debug_token on the app token)");
    else problems.push(`FAIL     REAL Meta call: app token invalid (error ${info.errorCode ?? "?"}); check META_APP_ID / META_APP_SECRET`);
  } catch (e) {
    problems.push(`FAIL     REAL Meta call failed: ${(e as Error).message}`);
  }
}
console.log(problems.length ? "\n" + problems.join("\n") + `\n\n${problems.length} item(s) need action before the real Meta test.` : "\nAll prerequisites present.");
process.exit(problems.some((p) => !p.startsWith("WARNING")) ? 1 : 0);
