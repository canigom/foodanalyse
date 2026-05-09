// GET /api/billing/status
//
// Returns the authenticated user's tier (trial / free / premium) plus the
// current daily limits applied to their account. The iOS client polls this
// on login + on screen focus to render the trial countdown banner and to
// know when to gate the camera flow behind the paywall.
//
// Trial state is derived from User.createdAt + 24h — see lib/trial.ts.
// "premium" is reserved for forward compat once we wire IAP/Stripe;
// today no one is premium so this branch is unreachable in practice.

import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { tierFor } from "@/lib/trial";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: { id: true, createdAt: true },
  });
  if (!user) {
    // Token valid but row gone (DSGVO delete, manual cleanup, etc.).
    // Treat as expired session so the iOS app bounces to login.
    return Response.json({ error: "User no longer exists" }, { status: 401 });
  }

  const t = tierFor(user);
  return Response.json({
    tier: t.tier,
    trialEndsAt: t.trialEndsAt ? new Date(t.trialEndsAt).toISOString() : null,
    msRemaining: t.msRemaining,
    limits: t.limits,
  });
}
