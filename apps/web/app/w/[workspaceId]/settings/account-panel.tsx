"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function AccountPanel({ name, email }: { name: string; email: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  return (
    <div className="flex flex-col gap-4 p-4">
      <dl className="grid grid-cols-[96px_1fr] gap-y-2 text-base">
        <dt className="text-fg-muted">Name</dt><dd className="min-w-0 truncate text-fg">{name}</dd>
        <dt className="text-fg-muted">Email</dt><dd className="min-w-0 truncate text-fg">{email}</dd>
      </dl>
      <div>
        <Button loading={busy} onClick={async () => { setBusy(true); await authClient.signOut(); router.replace("/login"); }}>Sign out</Button>
      </div>
    </div>
  );
}
