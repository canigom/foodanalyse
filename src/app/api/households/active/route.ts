// /api/households/active — PUT { householdId } → set the user's active
// household.
//
// The caller must be a member of the target household; otherwise 404.
// Returns the new activeHouseholdId so the iOS app can confirm and
// optimistically update its local cache.

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { requireMembership } from "@/lib/household";

export const runtime = "nodejs";

const ActiveSchema = z.object({
  householdId: z.string().min(1).max(64),
});

export async function PUT(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = ActiveSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const member = await requireMembership(parsed.data.householdId, auth.userId);
  if (!member) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  await db.user.update({
    where: { id: auth.userId },
    data: { activeHouseholdId: parsed.data.householdId },
  });

  return Response.json({ activeHouseholdId: parsed.data.householdId });
}
