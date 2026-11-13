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
