export type MailMessage = { to: string; subject: string; text: string; html?: string };
export interface Mailer {
  send(msg: MailMessage): Promise<{ id: string }>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Development and test implementation. Production providers are chosen with hosting (decision D22). */
export class MemoryMailer implements Mailer {
  readonly outbox: (MailMessage & { id: string })[] = [];
  async send(msg: MailMessage) {
    if (!EMAIL.test(msg.to)) throw new Error("invalid recipient");
    const id = crypto.randomUUID();
    this.outbox.push({ ...msg, id });
    return { id };
  }
}
