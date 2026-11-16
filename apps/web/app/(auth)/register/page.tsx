import type { Metadata } from "next";
import { safeNext } from "@/lib/safe-next";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Create account" };

export default async function RegisterPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return <AuthForm mode="register" next={safeNext(next)} />;
}
