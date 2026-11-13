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
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};
export default config;
