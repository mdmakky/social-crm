"use client";
import { ErrorState } from "@/components/ui/states";

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas p-4">
      <ErrorState title="Something went wrong" description="The page could not be loaded. Your data is safe. Try again, or reload in a moment." onRetry={reset} />
    </main>
  );
}
