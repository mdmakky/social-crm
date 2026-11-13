import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM with an environment key (decision D-D). OWNER-ONLY DEVELOPMENT: NOT production grade. A KMS-backed key and rotation job are a
 * mandatory release gate before external users. Every sealed value records its key id so keys can rotate; the account id is bound as AAD,
 * so a ciphertext copied to another account fails to open.
 */
export type SecretBox = {
  readonly keyId: string;
  seal(plain: string, aad: string): { ciphertext: Buffer; nonce: Buffer; keyId: string };
  open(sealed: { ciphertext: Buffer; nonce: Buffer; keyId: string }, aad: string): string;
};

export function createSecretBox(keys: Record<string, string>, currentKeyId: string): SecretBox {
  const bufs = new Map<string, Buffer>();
  for (const [id, b64] of Object.entries(keys)) {
    const k = Buffer.from(b64, "base64");
    if (k.length !== 32) throw new Error(`secret key ${id} must be 32 bytes (base64)`);
    bufs.set(id, k);
  }
  if (!bufs.has(currentKeyId)) throw new Error("current secret key id is not in the key set");
  return {
    keyId: currentKeyId,
    seal(plain, aad) {
      const nonce = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", bufs.get(currentKeyId)!, nonce);
      c.setAAD(Buffer.from(aad));
      const ct = Buffer.concat([c.update(plain, "utf8"), c.final(), c.getAuthTag()]);
      return { ciphertext: ct, nonce, keyId: currentKeyId };
    },
    open(sealed, aad) {
      const key = bufs.get(sealed.keyId);
      if (!key) throw new Error("unknown secret key id");
      const ct = sealed.ciphertext;
      const d = createDecipheriv("aes-256-gcm", key, sealed.nonce);
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(ct.subarray(ct.length - 16));
      return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString("utf8");
    },
  };
}
