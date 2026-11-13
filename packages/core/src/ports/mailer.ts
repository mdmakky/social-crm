export type MailMessage = { to: string; subject: string; text: string; html?: string };
export interface Mailer {
  send(msg: MailMessage): Promise<{ id: string }>;
}

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

type StoredMail = MailMessage & { id: string; sentAt: string };

/**
 * Local development adapter: one JSON file per message, so a developer (or a browser test) can open the
 * mail the app "sent". Not a production provider; production providers are chosen with hosting (D22).
 */
export class FileMailer implements Mailer {
  constructor(private readonly dir: string) {}

  async send(msg: MailMessage) {
    if (!EMAIL.test(msg.to)) throw new Error("invalid recipient");
    const id = crypto.randomUUID();
    await mkdir(this.dir, { recursive: true });
    const stored: StoredMail = { ...msg, id, sentAt: new Date().toISOString() };
    await writeFile(join(this.dir, `${process.hrtime.bigint().toString().padStart(24, "0")}-${id}.json`), JSON.stringify(stored, null, 2));
    return { id };
  }

  async messagesFor(to: string): Promise<StoredMail[]> {
    const files = (await readdir(this.dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort();
    const all = await Promise.all(files.map(async (f) => JSON.parse(await readFile(join(this.dir, f), "utf8")) as StoredMail));
    return all.filter((m) => m.to.toLowerCase() === to.toLowerCase());
  }
}
