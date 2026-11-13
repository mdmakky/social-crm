import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { endpoints } from "@crm/contracts";
import { dataOf, serverApi } from "@/lib/api";

export default async function Root() {
  const api = await serverApi();
  const me = await api.call(endpoints.me);
  if (!me.ok && me.error.status === 401) redirect("/login");
  const list = dataOf(await api.call(endpoints.listWorkspaces)) ?? [];
  if (list.length === 0) redirect("/onboarding");
  const last = (await cookies()).get("crm_last_ws")?.value;
  redirect(`/w/${list.find((w) => w.id === last)?.id ?? list[0]!.id}`);
}
