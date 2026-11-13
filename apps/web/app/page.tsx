import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { WorkspaceSummary } from "@crm/contracts";
import { apiGet } from "@/lib/api";

export default async function Root() {
  const me = await apiGet("/v1/me");
  if (me.status === 401) redirect("/login");
  const ws = await apiGet<WorkspaceSummary[]>("/v1/workspaces");
  const list = ws.data ?? [];
  if (list.length === 0) redirect("/onboarding");
  const last = (await cookies()).get("crm_last_ws")?.value;
  redirect(`/w/${list.find((w) => w.id === last)?.id ?? list[0]!.id}`);
}
