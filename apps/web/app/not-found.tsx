import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas p-4">
      <EmptyState title="We couldn't find that page" description="It may have moved, or you may not have access." action={<Button asChild variant="primary"><Link href="/">Go to your workspace</Link></Button>} />
    </main>
  );
}
