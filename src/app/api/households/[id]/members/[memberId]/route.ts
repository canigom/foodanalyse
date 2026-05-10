// /api/households/:id/members/:memberId — DELETE.
//
// Two flows:
//   1. Owner kicks a member: caller is the household owner and
//      memberId !== caller's HouseholdMember id.
//   2. Self-leave: caller's own HouseholdMember id matches memberId.
//
// Owners cannot leave their own household via this endpoint — they have
// to delete the household instead. The personal household has only the
// owner so a self-leave there would orphan the user's inventory.
//
// On a successful self-leave we re-pick activeHouseholdId via
// ensureActiveHousehold so the iOS app's next inventory fetch lands in a
// surviving household.

import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { ensureActiveHousehold } from "@/lib/household";

export const runtime = "nodejs";

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string; memberId: string }> },
) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const { id, memberId } = await ctx.params;

  // Look up the target member row + household ownership in one go so
  // we know who's being kicked and who owns the place.
  const member = await db.householdMember.findFirst({
    where: { id: memberId, householdId: id },
    select: {
      id: true,
      userId: true,
      role: true,
      household: { select: { ownerId: true } },
    },
  });
  if (!member) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const isOwnerCaller = member.household.ownerId === auth.userId;
  const isSelfLeave = member.userId === auth.userId;

  if (!isOwnerCaller && !isSelfLeave) {
    // Caller is neither the household owner nor the member themselves —
    // 404 to avoid leaking which membership ids exist.
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // The owner can't leave through this endpoint. They delete the
  // household instead, which cascades to all member rows.
  if (isSelfLeave && member.role === "owner") {
    return Response.json(
      { error: "owner_cannot_leave", message: "Eigentümer können den Haushalt nur löschen" },
      { status: 400 },
    );
  }

  await db.householdMember.delete({ where: { id: member.id } });

  // If we just removed ourselves, also re-pick activeHouseholdId.
  if (isSelfLeave) {
    const u = await db.user.findUnique({
      where: { id: auth.userId },
      select: { activeHouseholdId: true },
    });
    if (u?.activeHouseholdId === id) {
      await db.user.update({
        where: { id: auth.userId },
        data: { activeHouseholdId: null },
      });
    }
    const newActive = await ensureActiveHousehold(auth.userId);
    return Response.json({ ok: true, activeHouseholdId: newActive });
  }

  return Response.json({ ok: true });
}
