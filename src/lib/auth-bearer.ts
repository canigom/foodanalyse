// Bearer-token auth helper for API routes.
//
// Usage in a route handler:
//
//   const auth = await requireUser(req);
//   if (auth instanceof Response) return auth;
//   // auth is { userId, email }
//
// The "throw a Response" pattern would be cleaner, but Next.js doesn't catch
// thrown Responses inside route handlers — returning is safer.

import { verifySessionToken, type SessionClaims } from "@/lib/jwt";

const UNAUTHORIZED = (msg = "Unauthorized") =>
  Response.json({ error: msg }, { status: 401 });

export async function requireUser(
  req: Request,
): Promise<SessionClaims | Response> {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    return UNAUTHORIZED("Missing bearer token");
  }
  const token = header.slice("bearer ".length).trim();
  if (!token) return UNAUTHORIZED("Missing bearer token");

  try {
    return await verifySessionToken(token);
  } catch {
    // jose throws on expiry, signature mismatch, malformed token — all 401.
    return UNAUTHORIZED("Invalid or expired token");
  }
}

// Like requireUser, but returns null (instead of a 401 Response) when the
// caller is anonymous. Used by /api/analyze where auth is optional.
export async function optionalUser(
  req: Request,
): Promise<SessionClaims | null> {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice("bearer ".length).trim();
  if (!token) return null;
  try {
    return await verifySessionToken(token);
  } catch {
    return null;
  }
}
