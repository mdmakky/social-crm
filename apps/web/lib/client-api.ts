export type ClientResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message?: string };

/** Browser-side JSON request to the same-origin API proxy. */
export async function api<T = unknown>(path: string, init?: { method?: string; body?: unknown }): Promise<ClientResult<T>> {
  try {
    const res = await fetch(path, {
      method: init?.method ?? "GET",
      headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: "same-origin",
    });
    if (res.status === 204) return { ok: true, data: undefined as T };
    const json = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, code: json?.error?.code ?? "unknown", message: json?.error?.message };
    return { ok: true, data: json as T };
  } catch {
    return { ok: false, status: 0, code: "network", message: "Could not reach the server. Check your connection and try again." };
  }
}

const MESSAGES: Record<string, string> = {
  last_owner: "A workspace needs at least one owner. Make someone else an owner first.",
  admin_cannot_change_owner: "Admins cannot change an owner's role or remove an owner.",
  admin_cannot_grant_owner: "Only an owner can grant the owner role.",
  forbidden: "You don't have permission to do that.",
  not_found: "That item no longer exists.",
  network: "Could not reach the server. Check your connection and try again.",
  invalid_body: "Some of the values are not valid.",
};
export const errorMessage = (r: { code: string; message?: string }) => r.message ?? MESSAGES[r.code] ?? "Something went wrong. Please try again.";
