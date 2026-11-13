import type { Metadata, Viewport } from "next";
import "@fontsource-variable/plus-jakarta-sans";
import "./globals.css";

export const metadata: Metadata = { title: { default: "Social CRM", template: "%s · Social CRM" }, description: "Unified inbox, contacts and pipeline for social channels." };

export const viewport: Viewport = { themeColor: "#F6F7F9", colorScheme: "light" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
