import type { Metadata, Viewport } from "next";
import "@fontsource-variable/plus-jakarta-sans";
import "./globals.css";

export const metadata: Metadata = { title: { default: "Social CRM", template: "%s · Social CRM" }, description: "Unified inbox, contacts and leads for social channels.", appleWebApp: { capable: true, title: "Social CRM", statusBarStyle: "default" }, icons: { apple: "/icons/apple-touch-icon.png" } };

/** viewport-fit=cover lets the shell draw under the notch and home indicator (it pads with env(safe-area-inset-*)); resizes-content shrinks the layout above the keyboard so a sticky composer stays visible. */
export const viewport: Viewport = { themeColor: "#F6F7F9", colorScheme: "light", viewportFit: "cover", interactiveWidget: "resizes-content" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
