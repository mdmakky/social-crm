import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";

const WEB = `http://localhost:${process.env.E2E_WEB_PORT ?? "3217"}`;
const API = `http://localhost:${process.env.E2E_API_PORT ?? "8791"}`;
export const MAIL_DIR = join(__dirname, "test-results", "mail");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 45_000,
  use: { baseURL: WEB, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --filter @crm/api exec tsx src/server.ts",
      url: `${API}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: process.env.E2E_API_PORT ?? "8791",
        DATABASE_URL_APP: "postgres://crm_app:app_dev@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm") + "",
        BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-0123456789",
        BETTER_AUTH_URL: WEB,
        WEB_ORIGIN: WEB,
        MAIL_DIR,
        // Opt-in MOCK Meta (no Meta contact): lets the Integrations flow run end to end. Needs the worker role and a key; labelled mock in the UI.
        ...(process.env.E2E_META_MOCK === "1" ? { DATABASE_URL_WORKER: "postgres://crm_worker:worker_dev@127.0.0.1:5436/" + (process.env.CRM_DB_NAME ?? "crm"), META_APP_SECRET: "e2e-mock-app-secret-0123456789", SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"), META_MOCK: "1" } : {}),
      },
    },
    {
      command: `API_URL=${API} pnpm exec next build && API_URL=${API} pnpm exec next start -p ${process.env.E2E_WEB_PORT ?? "3217"}`,
      url: `${WEB}/login`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: { API_URL: API },
    },
  ],
});
