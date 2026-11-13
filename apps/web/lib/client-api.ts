import { createApiClient, type ApiError } from "@crm/api-client";

/** Shared typed client for browser code: same-origin, cookie session. */
export const browserApi = createApiClient({ baseUrl: "", auth: { mode: "cookie" } });

const MESSAGES: Record<string, string> = {
  last_owner: "A workspace needs at least one owner. Make someone else an owner first.",
  admin_cannot_change_owner: "Admins cannot change an owner's role or remove an owner.",
  admin_cannot_grant_owner: "Only an owner can grant the owner role.",
  forbidden: "You don't have permission to do that.",
  not_found: "That item no longer exists.",
  invalid_body: "Some of the values are not valid.",
  unauthenticated: "Your session has ended. Sign in again to continue.",
  contract_mismatch: "The app and the server are out of sync. Reload the page; if this keeps happening, update the app.",
};
export const errorMessage = (e: ApiError) => (e.kind === "network" || e.kind === "timeout" ? e.message : MESSAGES[e.code] ?? (e.kind === "http" && e.message && e.status < 500 ? e.message : "Something went wrong. Please try again."));
