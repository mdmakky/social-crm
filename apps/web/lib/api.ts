import "server-only";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { createApiClient, type ApiResult } from "@crm/api-client";

const API_URL = process.env.API_URL ?? "http://localhost:8787";

/** Shared typed client for server components. It forwards the visitor's session cookie to the API. */
export async function serverApi() {
  const cookie = (await cookies()).toString();
  return createApiClient({ baseUrl: API_URL, auth: { mode: "cookie" }, headers: () => ({ cookie }), timeoutMs: 10_000 });
}

export const dataOf = <T>(r: ApiResult<T>): T | null => (r.ok ? r.data : null);

/** Unwraps a result for a page that cannot render without it: 401 signs in, 404 is not-found, anything else is an error boundary. */
export function must<T>(r: ApiResult<T>): T {
  if (r.ok) return r.data;
  if (r.error.status === 401) redirect("/login");
  if (r.error.status === 404) notFound();
  throw new Error(r.error.message);
}
