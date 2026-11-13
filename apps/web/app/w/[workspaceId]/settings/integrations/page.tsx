import { redirect } from "next/navigation";

/** Integrations is a top-level page. This old URL stays because the Meta OAuth callback and saved links still point at it; the query string (?meta=, ?channel=) is preserved. */
export default async function LegacyIntegrationsRedirect({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspaceId } = await params;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, x);
  redirect(`/w/${workspaceId}/integrations${q.size ? `?${q}` : ""}`);
}
