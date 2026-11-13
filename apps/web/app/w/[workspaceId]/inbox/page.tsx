import type { Metadata } from "next";
import { Inbox } from "lucide-react";
import { EmptyState } from "@/components/ui/states";

export const metadata: Metadata = { title: "Inbox" };

/** Desktop and tablet placeholder when no conversation is selected (hidden below md by the shell: the list is the page there). */
export default function InboxIndex() {
  return <div className="flex flex-1 items-center justify-center"><EmptyState icon={Inbox} title="Select a conversation" description="Pick one from the list to read and manage it." /></div>;
}
