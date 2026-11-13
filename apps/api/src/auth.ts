import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { expo } from "@better-auth/expo";
import { PASSWORD_MIN_LENGTH, RESET_TOKEN_TTL_SECONDS } from "@crm/contracts";
import type { Mailer } from "@crm/core";
import type { Db } from "@crm/db";
import { auditPasswordReset, invalidateOtherResetTokens, resetEmail } from "./password-reset.ts";
import * as schema from "@crm/db/auth-schema";

export function createAuth(db: Db, opts: { secret: string; baseURL: string; trustedOrigins: string[]; mailer: Mailer }) {
  return betterAuth({
    secret: opts.secret,
    baseURL: opts.baseURL,
    trustedOrigins: opts.trustedOrigins,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      resetPasswordTokenExpiresIn: RESET_TOKEN_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      // Not awaited for delivery: response time must not reveal whether the account exists.
      sendResetPassword: async ({ user, url, token }) => {
        await invalidateOtherResetTokens(db, user.id, token);
        const mail = resetEmail(url, RESET_TOKEN_TTL_SECONDS / 60);
        void opts.mailer.send({ to: user.email, ...mail }).catch((e: unknown) => console.error("reset email failed", e instanceof Error ? e.message : e));
      },
      onPasswordReset: async ({ user }) => {
        await auditPasswordReset(db, user.id);
      },
    },
    // Sliding session expiry: no rotating refresh token is assumed (decision D27).
    session: { expiresIn: 60 * 60 * 24 * 30, updateAge: 60 * 60 * 24 },
    plugins: [bearer(), expo()],
  });
}
export type Auth = ReturnType<typeof createAuth>;
