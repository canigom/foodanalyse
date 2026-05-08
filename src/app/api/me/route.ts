// GET /api/me
//
// Returns the authenticated user's basic profile. The iOS app calls this
// on launch to validate that its stored bearer token is still good — the
// 401 lets it know to bounce back to the login screen.

import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: { id: true, email: true, name: true },
  });
  if (!user) {
    // Token was valid but the user has been deleted (DSGVO request, manual
    // cleanup, etc.). Treat as an expired session.
    return Response.json({ error: "User no longer exists" }, { status: 401 });
  }

  return Response.json({ user });
}
