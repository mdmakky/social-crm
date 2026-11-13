export function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
}
export function formatDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone }).format(new Date(iso));
}
export const ROLE_LABEL = { owner: "Owner", admin: "Admin", agent: "Agent", viewer: "Viewer" } as const;
