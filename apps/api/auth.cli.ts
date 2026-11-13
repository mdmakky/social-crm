// Used only by `@better-auth/cli generate` to emit the Drizzle schema.
import { createAuth } from "./src/auth.ts";
import { createDb } from "@crm/db";
export const auth = createAuth(createDb("postgres://x:x@127.0.0.1:1/x"), { secret: "x".repeat(32), baseURL: "http://localhost", trustedOrigins: [] });
