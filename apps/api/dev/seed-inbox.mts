// MOCK inbox fixtures for UI work. Inserts via the superuser connection (bypasses RLS on purpose; dev database only).
// Usage (from apps/api):  pnpm exec tsx --env-file-if-exists=../../.env dev/seed-inbox.mts <workspaceId>
import pg from "pg";

const ws = process.argv[2];
if (!ws || !/^[0-9a-f-]{36}$/i.test(ws)) throw new Error("usage: seed-inbox.mts <workspaceId>");
const c = new pg.Client({ connectionString: process.env.SEED_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5436/crm" });
await c.connect();
const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();
const digits = () => `5${Math.floor(Math.random() * 1e13).toString().padStart(13, "0")}`;
const q = async (t: string, p: unknown[] = []) => (await c.query(t, p)).rows;

const [w] = await q("SELECT owner_user_id FROM workspaces WHERE id=$1", [ws]);
if (!w) throw new Error("workspace not found");
const [stage] = await q("SELECT id FROM lifecycle_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1", [ws]);
if (!stage) throw new Error("workspace has no lifecycle stages");
let acct = (await q("SELECT id FROM integration_accounts WHERE workspace_id=$1 AND platform='messenger' AND display_name='Mock inbox (seed)'", [ws]))[0];
if (!acct) acct = (await q("INSERT INTO integration_accounts (workspace_id, platform, external_account_id, display_name) VALUES ($1,'messenger',$2,'Mock inbox (seed)') RETURNING id", [ws, digits()]))[0];

type M = { d: "in" | "out"; t?: string | null; at: number; state?: string; att?: unknown[] };
const people: { name: string; status?: string; msgs: M[] }[] = [
  { name: "Maria Lopez", msgs: [{ d: "in", t: "Hi, is the blue one available in size 38?", at: 42 }, { d: "out", t: "Hi Maria! Yes, we have 3 in stock.", at: 40 }, { d: "in", t: "Great. Can you deliver to Dhaka by Friday?", at: 3 }] },
  { name: "Jon Park", msgs: [{ d: "in", t: "Thanks for the quick reply!", at: 55 }, { d: "in", t: "One more question about the warranty.", at: 54 }] },
  { name: "Aisha Rahman", status: "pending", msgs: [{ d: "in", t: "I sent the payment screenshot.", at: 130, att: [{ type: "image", url: "https://example.com/mock/receipt.png" }] }, { d: "out", t: "Thanks, we are checking it now.", at: 125 }] },
  { name: "Carlos Mendes", msgs: [{ d: "in", t: "Do you ship internationally?", at: 60 * 30 }] },
  { name: "Priya Nair", msgs: [{ d: "in", t: "Hello?", at: 8 }, { d: "in", t: "Anyone there?", at: 7 }, { d: "in", t: "I need help with order #4821", at: 6 }] },
  { name: "Tomás Rivera", status: "resolved", msgs: [{ d: "in", t: "Received, all good. Thank you!", at: 60 * 5 }, { d: "out", t: "Glad to hear it. Anything else?", at: 60 * 5 - 2 }] },
  { name: "Lena Fischer", msgs: [{ d: "in", t: "Can I change the delivery address?", at: 20 }, { d: "out", t: "Sure, what is the new address?", at: 18, state: "unknown" }] },
  { name: "Omar Haddad", msgs: [{ d: "in", t: "Voice note", at: 15, att: [{ type: "audio", url: "https://example.com/mock/voice.m4a" }] }] },
  { name: "Sofia Rossi", msgs: [{ d: "in", t: "Is there a discount for 10 pieces?", at: 95 }, { d: "out", t: "Let me check with the team.", at: 90, state: "failed" }] },
  { name: "Daniel Kim", msgs: [{ d: "out", t: "Hi Daniel, thanks for your interest. How can we help?", at: 240 }] },
  { name: "Fatima Zahra", msgs: [{ d: "in", t: null, at: 12, att: [{ type: "image", url: "https://example.com/mock/photo1.jpg" }, { type: "image", url: "https://example.com/mock/photo2.jpg" }] }] },
  { name: "Ivan Petrov", status: "pending", msgs: [{ d: "in", t: "Waiting for the invoice please.", at: 300 }, { d: "out", t: "Invoice sent to your email.", at: 295 }, { d: "in", t: "Got it, thanks", at: 290 }] },
];
let n = 0;
for (const p of people) {
  const [ct] = await q("INSERT INTO contacts (workspace_id, name, lifecycle_stage_id, source) VALUES ($1,$2,$3,'messenger') RETURNING id", [ws, p.name, stage.id]);
  const [idn] = await q("INSERT INTO platform_identities (workspace_id, integration_account_id, external_user_id, contact_id) VALUES ($1,$2,$3,$4) RETURNING id", [ws, acct.id, digits(), ct.id]);
  const [cv] = await q("INSERT INTO conversations (workspace_id, integration_account_id, identity_id, contact_id, status) VALUES ($1,$2,$3,$4,$5) RETURNING id", [ws, acct.id, idn.id, ct.id, p.status ?? "open"]);
  for (const m of [...p.msgs].sort((a, b) => b.at - a.at)) {
    const inbound = m.d === "in";
    await q(
      `INSERT INTO messages (workspace_id, conversation_id, integration_account_id, direction, external_id, sender_kind, sender_user_id, body, attachments, delivery_state, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
      [ws, cv.id, acct.id, m.d, inbound ? `seed.${digits()}` : null, inbound ? "contact" : "user", inbound ? null : w.owner_user_id, m.t ?? null, JSON.stringify(m.att ?? []), inbound ? "received" : (m.state ?? "sent"), ago(m.at)],
    );
  }
  const ins = p.msgs.filter((m) => m.d === "in").map((m) => m.at);
  await q("UPDATE conversations SET last_message_at=$2::timestamptz, last_inbound_at=$3::timestamptz WHERE id=$1", [cv.id, ago(Math.min(...p.msgs.map((m) => m.at))), ins.length ? ago(Math.min(...ins)) : null]);
  n++;
}
console.log(`seeded ${n} MOCK conversations into workspace ${ws} (account "Mock inbox (seed)")`);
await c.end();
