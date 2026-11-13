import "server-only";
import { cookies } from "next/headers";

const API_URL = process.env.API_URL ?? "http://localhost:8787";

export type ApiResult<T> = { status: number; data: T | null };

/** Server-side GET that forwards the visitor's session cookie to the API. */
export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  const cookie = (await cookies()).toString();
  try {
    const res = await fetch(`${API_URL}${path}`, { headers: { cookie }, cache: "no-store" });
    // Error bodies are never returned as data, so callers can rely on `data` meaning success.
    const data = res.ok && res.headers.get("content-type")?.includes("json") ? ((await res.json()) as T) : null;
    return { status: res.status, data };
  } catch {
    return { status: 0, data: null };
  }
}
