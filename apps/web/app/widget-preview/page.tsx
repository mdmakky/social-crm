import type { Metadata } from "next";
import { Sample } from "./sample";

export const metadata: Metadata = { title: "Sample page", robots: { index: false, follow: false } };

/** A made-up landing page that the owner preview (settings, web chat) shows in a frame. It loads the real /widget.js exactly like a customer's site would. Only our own settings page may frame it (next.config.ts). */
export default function SamplePage() {
  return <Sample />;
}
