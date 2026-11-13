import type { Metadata } from "next";
import Link from "next/link";
import { LinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const { token, error } = await searchParams;
  if (!token || error) {
    return (
      <div className="flex flex-col gap-4" role="alert">
        <LinkIcon className="size-5 text-fg-subtle" aria-hidden />
        <div>
          <h1 className="text-lg font-semibold tracking-title text-fg">This link can&rsquo;t be used</h1>
          <p className="mt-1 text-sm text-fg-muted">Reset links expire after 30 minutes and work once. Request a new one to continue.</p>
        </div>
        <div><Button asChild variant="primary"><Link href="/forgot-password">Request a new link</Link></Button></div>
      </div>
    );
  }
  return <ResetPasswordForm token={token} />;
}
