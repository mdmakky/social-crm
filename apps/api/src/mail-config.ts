import { randomToken, createMailgunProvider, MockEmailProvider, MOCK_SIGNING_KEY, type EmailProvider } from "@crm/integrations";
import type { Mailer } from "@crm/core";

export type MailEnv = {
  NODE_ENV: string;
  MAIL_PROVIDER: "file" | "mock" | "mailgun";
  MAILGUN_API_KEY?: string | undefined;
  MAILGUN_SIGNING_KEY?: string | undefined;
  MAILGUN_DOMAIN?: string | undefined;
  MAILGUN_BASE_URL?: string | undefined;
  EMAIL_INBOUND_DOMAIN?: string | undefined;
  META_MOCK?: string | undefined;
};

/**
 * Production mail guard (decisions D22, D259). Fails closed: in production the process refuses to start unless MAIL_PROVIDER is explicitly "mailgun" AND every key it needs is present.
 * "file" and "mock" are development adapters and never run in production. Mailgun itself is UNVERIFIED (never called for real); setting the variables is the owner's statement that they accept that.
 * Only variable NAMES appear in the message, never values.
 */
export function assertMailProduction(env: MailEnv): void {
  if (env.NODE_ENV !== "production") return;
  if (env.MAIL_PROVIDER !== "mailgun") throw new Error("No production mail provider is configured (decision D22). Set MAIL_PROVIDER=mailgun with its keys, or password reset would not work.");
  const missing = (["MAILGUN_API_KEY", "MAILGUN_SIGNING_KEY", "MAILGUN_DOMAIN", "EMAIL_INBOUND_DOMAIN"] as const).filter((k) => !env[k]);
  if (missing.length) throw new Error(`MAIL_PROVIDER=mailgun needs ${missing.join(", ")} (decision D259).`);
}

export type EmailSetup = { provider: EmailProvider; signingKeys: string[]; inboundDomain: string; sendingDomain: string; mock: boolean };

/** The email channel's provider for this process, or null when the channel is off. Mock: MAIL_PROVIDER=mock, or the Meta mock flag (E2E) while MAIL_PROVIDER is left at "file". Never mock in production (the guard above already requires mailgun). */
export function emailSetup(env: MailEnv): EmailSetup | null {
  if (env.MAIL_PROVIDER === "mailgun") {
    if (!env.MAILGUN_API_KEY || !env.MAILGUN_SIGNING_KEY || !env.MAILGUN_DOMAIN || !env.EMAIL_INBOUND_DOMAIN) return null;
    return { provider: createMailgunProvider({ apiKey: env.MAILGUN_API_KEY, domain: env.MAILGUN_DOMAIN, baseUrl: env.MAILGUN_BASE_URL }), signingKeys: [env.MAILGUN_SIGNING_KEY], inboundDomain: env.EMAIL_INBOUND_DOMAIN.toLowerCase(), sendingDomain: env.MAILGUN_DOMAIN.toLowerCase(), mock: false };
  }
  if (env.NODE_ENV === "production") return null;
  if (env.MAIL_PROVIDER === "mock" || env.META_MOCK === "1") {
    const d = (env.EMAIL_INBOUND_DOMAIN ?? "inbound.mock.example.test").toLowerCase();
    return { provider: new MockEmailProvider(), signingKeys: [MOCK_SIGNING_KEY], inboundDomain: d, sendingDomain: d, mock: true };
  }
  return null;
}

/** The existing Mailer port (password reset, invitations) on top of the same provider. Plain text only; marked auto-generated so mail loops are not triggered. */
export function providerMailer(provider: EmailProvider, domain: string): Mailer {
  return {
    async send(m) {
      const messageId = `${randomToken(24)}@${domain}`;
      await provider.send({ from: { name: "Social CRM", address: `noreply@${domain}` }, to: m.to, replyTo: `noreply@${domain}`, subject: m.subject, text: m.text, messageId, inReplyTo: null, references: [], autoSubmitted: "auto-generated" });
      return { id: messageId };
    },
  };
}
