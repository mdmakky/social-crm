import type { Metadata } from "next";
import { safeNext } from "@/lib/safe-next";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; reset?: string }> }) {
  const { next, reset } = await searchParams;
  return <AuthForm mode="login" next={safeNext(next)} notice={reset === "1" ? "Password updated. Sign in with your new password." : undefined} />;
}
