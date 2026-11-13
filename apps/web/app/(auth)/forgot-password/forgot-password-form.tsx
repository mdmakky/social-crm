"use client";
import * as React from "react";
import Link from "next/link";
import { MailCheck } from "lucide-react";
import { RESET_TOKEN_TTL_SECONDS } from "@crm/contracts";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/states";
import { authClient } from "@/lib/auth-client";

export function ForgotPasswordForm() {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [sentTo, setSentTo] = React.useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email") ?? "").trim();
    setFormError(null);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Enter a valid email address.");
      e.currentTarget.querySelector<HTMLInputElement>("[name=email]")?.focus();
      return;
    }
    setError(null);
    setBusy(true);
    const res = await authClient.requestPasswordReset({ email, redirectTo: `${window.location.origin}/reset-password` });
    setBusy(false);
    // The server answers the same way whether or not the address has an account, so the screen does too.
    if (res.error && !res.error.status) return setFormError("Could not reach the server. Check your connection and try again.");
    if (res.error && res.error.status >= 500) return setFormError("Something went wrong on our side. Please try again in a moment.");
    setSentTo(email);
  }

  if (sentTo) {
    return (
      <div className="flex flex-col gap-4" role="status">
        <MailCheck className="size-5 text-accent-fg" aria-hidden />
        <div>
          <h1 className="text-lg font-semibold tracking-title text-fg">Check your email</h1>
          <p className="mt-1 text-sm text-fg-muted">
            If an account exists for <span className="font-medium text-fg">{sentTo}</span>, we&rsquo;ve sent a link to choose a new password. It works for {RESET_TOKEN_TTL_SECONDS / 60} minutes and only once.
          </p>
          <p className="mt-2 text-sm text-fg-muted">Nothing arrived? Check spam, or try again with the address you signed up with.</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="primary"><Link href="/login">Back to sign in</Link></Button>
          <Button variant="ghost" onClick={() => setSentTo(null)}>Use another email</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-title text-fg">Reset your password</h1>
        <p className="mt-0.5 text-sm text-fg-muted">Enter your account email and we&rsquo;ll send you a link to choose a new password.</p>
      </div>
      {formError && <Alert tone="error">{formError}</Alert>}
      <Field label="Email" error={error}>
        {(p) => <Input {...p} name="email" type="email" autoComplete="email" inputMode="email" autoFocus />}
      </Field>
      <Button type="submit" variant="primary" size="lg" loading={busy}>Send reset link</Button>
      <p className="text-center text-sm text-fg-muted"><Link href="/login" className="font-medium text-accent-fg underline underline-offset-2">Back to sign in</Link></p>
    </form>
  );
}
