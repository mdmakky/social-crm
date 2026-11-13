import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Thread } from "@/components/inbox/thread";

export const metadata: Metadata = { title: "Inbox" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  if (!UUID.test(conversationId)) notFound();
  return <Thread key={conversationId} conversationId={conversationId} />;
}
