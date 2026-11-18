import type { MetadataRoute } from "next";

/** Installable web app. Deliberately no service worker: nothing is cached or queued offline, so a reply can never appear sent when it was not (see docs/project/known-limitations.md). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Social CRM",
    short_name: "Social CRM",
    description: "Unified inbox and leads for social channels.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#F6F7F9",
    theme_color: "#F6F7F9",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
