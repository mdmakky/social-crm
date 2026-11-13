import type { Role } from "@crm/core/permissions";

export type ShellWorkspace = { id: string; name: string; slug: string; role: Role };
export type ShellUser = { id: string; name: string; email: string };
