import type { Metadata } from "next";
import { Chat } from "./chat";

export const metadata: Metadata = { title: "Chat", robots: { index: false, follow: false } };

/** The page that website visitors see inside the chat iframe. It is outside the signed-in app (no shell, no session cookie use) and is framed by the sites the widget allows (see proxy.ts). */
export default async function WidgetPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return <Chat widgetKey={key} />;
}
