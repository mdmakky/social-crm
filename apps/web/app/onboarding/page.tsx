import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Logo } from "@/components/shell/logo";
import { endpoints } from "@crm/contracts";
import { serverApi } from "@/lib/api";
import { CreateWorkspaceForm } from "./create-workspace-form";

export const metadata: Metadata = { title: "Create workspace" };

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const me = await (await serverApi()).call(endpoints.me);
  if (!me.ok && me.error.status === 401) redirect("/login?next=/onboarding");
  const { new: isNew } = await searchParams;
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-10">
      <Logo className="mb-6" />
      <div className="w-full max-w-md rounded-card border border-line bg-surface p-6">
        <CreateWorkspaceForm canCancel={!!isNew} />
      </div>
    </main>
  );
}
