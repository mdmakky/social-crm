import { Logo } from "@/components/shell/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-10">
      <Logo className="mb-6" />
      <div className="w-full max-w-sm rounded-xl border border-line bg-surface p-6">{children}</div>
    </main>
  );
}
