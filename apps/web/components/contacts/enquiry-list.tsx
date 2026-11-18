"use client";
import Link from "next/link";
import type { ContactSummary } from "@crm/contracts";
import { Avatar } from "@/components/ui/avatar";
import { ChannelBadge } from "@/components/inbox/parts";
import { relativeTime } from "@/lib/contacts";
import { AddPhone } from "./add-phone";

type Platform = Parameters<typeof ChannelBadge>[0]["platform"];

/**
 * Enquiries (D310): people who wrote to you but have not given a phone number. No stage, no value. One list for every width: a stacked card on a phone, one row from 768 px.
 * The row opens the lead page; "Add phone" is the only action that changes the person (they move to Leads, New).
 */
export function EnquiryList({ items, workspaceId, timeZone, canEdit, onMoved }: { items: ContactSummary[]; workspaceId: string; timeZone: string; canEdit: boolean; onMoved: () => void }) {
  return (
    <ul aria-label="Enquiries">
      {items.map((c) => {
        const cv = c.conversation;
        return (
          <li key={c.id} className="flex flex-col gap-2 border-b border-line-card px-4 py-3 last:border-b-0 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(14rem,auto)] md:items-center md:gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <Avatar name={c.name} size="xl" />
              <div className="min-w-0">
                <Link href={`/w/${workspaceId}/contacts/${c.id}`} className="block truncate font-medium text-fg hover:underline pointer-coarse:py-2">{c.name}</Link>
                <div className="flex flex-wrap items-center gap-1.5 text-sm text-fg-subtle">
                  {cv ? <ChannelBadge platform={cv.platform as Platform} /> : <span>No conversation yet</span>}
                  {cv?.lastMessageAt && <span className="tnum">{relativeTime(cv.lastMessageAt, timeZone)}</span>}
                </div>
              </div>
            </div>
            <div className="min-w-0 text-sm text-fg-muted">
              {cv?.preview ? <p className="line-clamp-2 break-words md:line-clamp-1">{cv.previewDirection === "out" && <span className="sr-only">You: </span>}{cv.preview}</p> : <p className="text-fg-subtle">{cv ? "Attachment or no text" : ""}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2 md:justify-end">
              {canEdit && <AddPhone workspaceId={workspaceId} contactId={c.id} version={c.version} name={c.name} onSaved={onMoved} />}
              {cv && <Link href={`/w/${workspaceId}/inbox/${cv.id}`} className="press inline-flex h-8 items-center rounded-control border border-line px-3 text-sm font-medium text-fg hover:bg-hover pointer-coarse:min-h-11 max-md:min-h-11">Open in Inbox</Link>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
