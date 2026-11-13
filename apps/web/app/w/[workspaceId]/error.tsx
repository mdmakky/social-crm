"use client";
import { ErrorState } from "@/components/ui/states";

export default function WorkspaceError({ reset }: { error: Error; reset: () => void }) {
  return <ErrorState title="This page could not be loaded" description="Your data is safe. Check your connection and try again." onRetry={reset} />;
}
