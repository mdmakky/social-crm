"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PASSWORD_MIN_LENGTH } from "@crm/contracts";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/states";
import { authClient } from "@/lib/auth-client";

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<{ password?: string; confirm?: string }>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [expired, setExpired] = React.useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const password = String(f.get("password") ?? "");
    const confirm = String(f.get("confirm") ?? "");
    const next: typeof errors = {};
    if (password.length < PASSWORD_MIN_LENGTH) next.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
    else if (confirm !== password) next.confirm = "The passwords don't match.";
    setErrors(next);
    setFormError(null);
    const first = next.password ? "password" : next.confirm ? "confirm" : null;
    if (first) return void e.currentTarget.querySelector<HTMLInputElement>(`[name=${first}]`)?.focus();

    setBusy(true);
    const res = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (res.error) {
      if (!res.error.status) return setFormError("Could not reach the server. Check your connection and try again.");
      if (res.error.status === 429) return setFormError("Too many attempts. Wait a few minutes and try again.");
      if (res.error.status === 400 && /token/i.test(`${res.error.code} ${res.error.message}`)) return setExpired(true);
      return setFormError("We couldn't update your password. Check it meets the requirements and try again.");
    }
    router.replace("/login?reset=1");
  }

  if (expired) {
    return (
      <div className="flex flex-col gap-4" role="alert">
        <div>
          <h1 className="text-2xl font-bold tracking-[-0.025em] text-fg">This link has expired</h1>
          <p className="mt-1 text-sm text-fg-muted">Reset links expire after 30 minutes and work once. Request a new one to continue.</p>
        </div>
        <div><Button asChild variant="primary"><Link href="/forgot-password">Request a new link</Link></Button></div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-[-0.025em] text-fg">Choose a new password</h1>
        <p className="mt-1.5 text-md text-fg-muted">You&rsquo;ll be signed out everywhere else once it&rsquo;s changed.</p>
      </div>
      {formError && <Alert tone="error">{formError}</Alert>}
      <Field label="New password" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`} error={errors.password}>
        {(p) => <Input {...p} className="h-11" name="password" type="password" autoComplete="new-password" autoFocus />}
      </Field>
      <Field label="Confirm new password" error={errors.confirm}>
        {(p) => <Input {...p} className="h-11" name="confirm" type="password" autoComplete="new-password" />}
      </Field>
      <Button type="submit" variant="primary" size="lg" className="h-12 text-md" loading={busy}>Update password</Button>
    </form>
  );
}
