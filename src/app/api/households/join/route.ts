// /api/households/join — POST { inviteCode } → join as member.
//
// Joins the caller as a member (role: 'member') of the household whose
// invite code matches. On success the joined household becomes the
// caller's active one so the iOS app can pop straight to inventory and
// see the shared fridge immediately.
//
// Returns 404 for invalid / expired codes; we don't differentiate so a
// scraper can't probe the code space.

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { ensureActiveHousehold } from "@/lib/household";

export const runtime = "nodejs";

const JoinSchema = z.object({
  inviteCode: z.string().min(4).max(32),
});

export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = JoinSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Normalize — invite codes are case-insensitive on the user-facing
  // side; the iOS keyboard usually does this for us but be defensive.
  const code = parsed.data.inviteCode.trim().toUpperCase();

  const household = await db.household.findUnique({
    where: { inviteCode: code },
    select: {
      id: true,
      name: true,
      ownerId: true,
      createdAt: true,
      inviteCode: true,
      inviteExpiresAt: true,
    },
  });
  if (!household) {
    return Response.json({ error: "invalid_code" }, { status: 404 });
  }
  if (household.inviteExpiresAt && household.inviteExpiresAt < new Date()) {
    return Response.json({ error: "invalid_code" }, { status: 404 });
  }

  // Ensure the caller has a personal household before adding them to
  // someone else's — keeps the lazy-create invariant intact.
  await ensureActiveHousehold(auth.userId);

  // Idempotent join. If already a member, just flip activeHouseholdId
  // and return the same household.
  const existing = await db.householdMember.findUnique({
    where: {
      householdId_userId: { householdId: household.id, userId: auth.userId },
    },
    select: { id: true },
  });
  if (!existing) {
    await db.householdMember.create({
      data: {
        householdId: household.id,
        userId: auth.userId,
        role: "member",
      },
    });
  }

  await db.user.update({
    where: { id: auth.userId },
    data: { activeHouseholdId: household.id },
  });

  return Response.json({
    household: {
      id: household.id,
      name: household.name,
      ownerId: household.ownerId,
      createdAt: household.createdAt,
    },
  });
}
