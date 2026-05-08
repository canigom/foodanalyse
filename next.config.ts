import type { NextConfig } from "next";
import path from "node:path";

// Security headers applied to every response. Each one closes a known
// attack class. CSP is skipped on purpose — KochHeute is API-only and
// served to a native iOS client, so the strictest reasonable CSP would
// only matter for the placeholder root page.
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },

  // `standalone` produces a self-contained .next/standalone/ folder with
  // server.js + minimal node_modules — smallest possible Docker image.
  output: "standalone",

  // The standalone tracer doesn't always pick up Prisma's runtime engine.
  // Force-include it so `node server.js` can talk to the DB at runtime.
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./node_modules/.prisma/client/**/*",
      "./node_modules/@prisma/client/**/*",
    ],
  },

  // Pin Turbopack's workspace root to this folder so it doesn't pick up
  // an unrelated lockfile higher up the directory tree.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
