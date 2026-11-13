"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/states";
import { authClient } from "@/lib/auth-client";

const MIN = 10;

export function AuthForm({ mode, next }: { mode: "login" | "register"; next: string }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<{ name?: string; email?: string; password?: string }>({});
  const register = mode === "register";

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get("name") ?? "").trim();
    const email = String(f.get("email") ?? "").trim();
    const password = String(f.get("password") ?? "");
    const next_: typeof errors = {};
    if (register && name.length < 2) next_.name = "Enter your name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) next_.email = "Enter a valid email address.";
    if (!password) next_.password = "Enter your password.";
    else if (register && password.length < MIN) next_.password = `Use at least ${MIN} characters.`;
    setErrors(next_);
    setFormError(null);
    if (Object.keys(next_).length) return;

    setBusy(true);
    const res = register ? await authClient.signUp.email({ name, email, password }) : await authClient.signIn.email({ email, password });
    if (res.error) {
      setBusy(false);
      const code = res.error.code ?? "";
      setFormError(
        code === "USER_ALREADY_EXISTS" || /already exists/i.test(res.error.message ?? "")
          ? "An account with this email already exists. Sign in instead."
          : res.error.status === 0 || !res.error.status
            ? "Could not reach the server. Check your connection and try again."
            : register
              ? res.error.message || "We couldn't create your account. Please try again."
              : "Email or password is incorrect.",
      );
      return;
    }
    router.replace(next);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-[-0.01em] text-fg">{register ? "Create your account" : "Sign in"}</h1>
        <p className="mt-0.5 text-sm text-fg-muted">{register ? "Start with a workspace for your business." : "Welcome back. Pick up your conversations."}</p>
      </div>
      {formError && <Alert tone="error">{formError}</Alert>}
      {register && (
        <Field label="Full name" error={errors.name}>
          {(p) => <Input {...p} name="name" autoComplete="name" autoFocus />}
        </Field>
      )}
      <Field label="Email" error={errors.email}>
        {(p) => <Input {...p} name="email" type="email" autoComplete="email" inputMode="email" autoFocus={!register} />}
      </Field>
      <Field label="Password" hint={register ? `At least ${MIN} characters.` : undefined} error={errors.password}>
        {(p) => <Input {...p} name="password" type="password" autoComplete={register ? "new-password" : "current-password"} />}
      </Field>
      <Button type="submit" variant="primary" size="lg" loading={busy}>{register ? "Create account" : "Sign in"}</Button>
      <p className="text-center text-sm text-fg-muted">
        {register ? "Already have an account? " : "New here? "}
        <Link href={register ? "/login" : "/register"} className="font-medium text-accent-fg underline underline-offset-2">{register ? "Sign in" : "Create an account"}</Link>
      </p>
    </form>
  );
}
