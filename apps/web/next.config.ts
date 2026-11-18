import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://localhost:8787";

const config: NextConfig = {
  transpilePackages: ["@crm/contracts", "@crm/core", "@crm/design-tokens"],
  // Same-origin proxy: the browser only talks to the web origin, so session cookies stay first-party.
  async rewrites() {
    return [
      { source: "/api/auth/:path*", destination: `${API_URL}/api/auth/:path*` },
      { source: "/v1/:path*", destination: `${API_URL}/v1/:path*` },
    ];
  },
  poweredByHeader: false,
  // The AI pages became tabs of one hub (settings/ai). Old links, bookmarks and notifications keep working.
  async redirects() {
    return [
      { source: "/w/:workspaceId/settings/ai-agents", destination: "/w/:workspaceId/settings/ai/agents", permanent: false },
      { source: "/w/:workspaceId/settings/knowledge", destination: "/w/:workspaceId/settings/ai/knowledge", permanent: false },
      { source: "/w/:workspaceId/settings/automations", destination: "/w/:workspaceId/settings/ai/automations", permanent: false },
    ];
  },
  async headers() {
    return [
      // Everything except the widget page keeps the frame ban. The widget page is MEANT to be framed by customer sites: its frame-ancestors is set per widget in proxy.ts (the widget's allowed origins, or 'none').
      {
        source: "/((?!widget/).*)",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        source: "/widget/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      // The loader is a public static file other sites include; keep it cacheable for a short while only so a fix reaches customers quickly.
      { source: "/widget.js", headers: [{ key: "Cache-Control", value: "public, max-age=300" }, { key: "X-Content-Type-Options", value: "nosniff" }] },
    ];
  },
};
export default config;
