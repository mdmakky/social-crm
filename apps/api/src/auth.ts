import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { expo } from "@better-auth/expo";
import type { Db } from "@crm/db";
import * as schema from "@crm/db/auth-schema";

export function createAuth(db: Db, opts: { secret: string; baseURL: string; trustedOrigins: string[] }) {
  return betterAuth({
    secret: opts.secret,
    baseURL: opts.baseURL,
    trustedOrigins: opts.trustedOrigins,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    // Sliding session expiry: no rotating refresh token is assumed (decision D27).
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    plugins: [bearer(), expo()],
  });
}
export type Auth = ReturnType<typeof createAuth>;
