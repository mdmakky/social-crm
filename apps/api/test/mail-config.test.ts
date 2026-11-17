import { describe, expect, it } from "vitest";
import { assertMailProduction, emailSetup, providerMailer, type MailEnv } from "../src/mail-config.ts";
import { MockEmailProvider } from "@crm/integrations";

const real = { MAILGUN_API_KEY: "key-0123456789", MAILGUN_SIGNING_KEY: "sign-0123456789", MAILGUN_DOMAIN: "mg.example.com", EMAIL_INBOUND_DOMAIN: "in.example.com" };

describe("production mail guard (D22, D259): still fails closed", () => {
  const prod = (o: Partial<MailEnv>): MailEnv => ({ NODE_ENV: "production", MAIL_PROVIDER: "file", ...o });
  it("throws in production without an explicit real provider", () => {
    expect(() => assertMailProduction(prod({}))).toThrow(/No production mail provider is configured/);
    expect(() => assertMailProduction(prod({ MAIL_PROVIDER: "mock", ...real }))).toThrow(/No production mail provider/);
    expect(() => assertMailProduction(prod({ META_MOCK: "1" }))).toThrow(/No production mail provider/);
  });
  it("throws for mailgun when any key is missing, naming only the variable", () => {
    expect(() => assertMailProduction(prod({ MAIL_PROVIDER: "mailgun" }))).toThrow(/MAILGUN_API_KEY, MAILGUN_SIGNING_KEY, MAILGUN_DOMAIN, EMAIL_INBOUND_DOMAIN/);
    const { MAILGUN_SIGNING_KEY: _s, ...partial } = real;
    let msg = "";
    try { assertMailProduction(prod({ MAIL_PROVIDER: "mailgun", ...partial })); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain("MAILGUN_SIGNING_KEY");
    expect(msg).not.toContain("key-0123456789");
  });
  it("passes with MAIL_PROVIDER=mailgun and all keys (env injected)", () => {
    expect(() => assertMailProduction(prod({ MAIL_PROVIDER: "mailgun", ...real }))).not.toThrow();
  });
  it("is not applied outside production", () => {
    expect(() => assertMailProduction({ NODE_ENV: "development", MAIL_PROVIDER: "file" })).not.toThrow();
  });
});

describe("email setup", () => {
  it("mock is chosen for MAIL_PROVIDER=mock or the Meta mock flag, never in production; file means off", () => {
    expect(emailSetup({ NODE_ENV: "development", MAIL_PROVIDER: "file" })).toBeNull();
    expect(emailSetup({ NODE_ENV: "development", MAIL_PROVIDER: "mock" })).toMatchObject({ mock: true, provider: { name: "mock" } });
    expect(emailSetup({ NODE_ENV: "development", MAIL_PROVIDER: "file", META_MOCK: "1" })).toMatchObject({ mock: true });
    expect(emailSetup({ NODE_ENV: "production", MAIL_PROVIDER: "file", META_MOCK: "1" })).toBeNull();
    expect(emailSetup({ NODE_ENV: "production", MAIL_PROVIDER: "mock" })).toBeNull();
  });
  it("mailgun needs all keys; domains are lower-cased", () => {
    expect(emailSetup({ NODE_ENV: "production", MAIL_PROVIDER: "mailgun", MAILGUN_API_KEY: "key-0123456789" })).toBeNull();
    expect(emailSetup({ NODE_ENV: "production", MAIL_PROVIDER: "mailgun", ...real, EMAIL_INBOUND_DOMAIN: "IN.Example.com" })).toMatchObject({ mock: false, provider: { name: "mailgun" }, inboundDomain: "in.example.com", sendingDomain: "mg.example.com" });
  });
  it("the Mailer port can ride on the provider: plain text, marked auto-generated", async () => {
    const p = new MockEmailProvider();
    await providerMailer(p, "mg.example.com").send({ to: "a@example.org", subject: "Reset", text: "link", html: "<b>ignored</b>" });
    expect(p.outbox[0]).toMatchObject({ to: "a@example.org", text: "link", autoSubmitted: "auto-generated", from: { address: "noreply@mg.example.com" } });
  });
});
