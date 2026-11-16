import type { Metadata } from "next";
import Link from "next/link";
import { endpoints } from "@crm/contracts";
import { Alert } from "@/components/ui/states";
import { serverApi } from "@/lib/api";
import { InvitePanel } from "./invite-panel";

export const metadata: Metadata = { title: "Invitation", robots: { index: false }, referrer: "no-referrer" };

/** Public: the token in the URL is the credential. Unknown, expired, revoked and used links all look the same. */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const api = await serverApi();
  const [preview, me] = await Promise.all([api.call(endpoints.previewInvitation, { query: { token } }), api.call(endpoints.me)]);
  if (!preview.ok) {
    const busy = preview.error.status === 429;
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold tracking-[-0.025em] text-fg">{busy ? "Try again soon" : "Link not valid"}</h1>
        <Alert tone="error">{busy ? "Too many attempts. Try again in a few minutes." : "This invitation is no longer valid. Ask for a new one."}</Alert>
        <Link href="/" className="text-sm font-medium text-accent-fg underline underline-offset-2">Go to the app</Link>
      </div>
    );
  }
  return <InvitePanel token={token} preview={preview.data} me={me.ok ? { email: me.data.email } : null} />;
}
