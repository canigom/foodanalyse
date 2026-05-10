// /api/households/:id — PATCH (rename, owner-only) + DELETE (owner-only,
// forbid deleting the last household).
//
// Tenant guard: ownership is enforced via `where: { id, ownerId }` rather
// than findFirst → 404 so a guessed id stays indistinguishable from a
// non-owned one.
//
// Delete semantics: when the deleted household was the user's active one
// we re-pick the next available household via ensureActiveHousehold so
// inventory queries don't leave them in limbo. Inventory items in the
// deleted household get their householdId nulled (FK is SetNull); the
// inventory route's read-time fallback then surfaces them under the
// user's new active household automatically.

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { LIMITS } from "@/lib/limits";
import { ensureActiveHousehold } from "@/lib/household";

export const runtime = "nodejs";

const PatchSchema = z.object({
  name: z.string().min(1).max(LIMITS.recipeName),
});

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await db.household.findFirst({
    where: { id, ownerId: auth.userId },
    select: { id: true },
  });
  if (!existing) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const household = await db.household.update({
    where: { id },
    data: { name: parsed.data.name },
  });
  return Response.json({ household });
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const { id } = await ctx.params;

  const existing = await db.household.findFirst({
    where: { id, ownerId: auth.userId },
    select: { id: true },
  });
  if (!existing) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Forbid deleting the last household the user belongs to — they need at
  // least one for inventory to land in. The membership count check covers
  // both ownership and shared-in cases.
  const totalMemberships = await db.householdMember.count({
    where: { userId: auth.userId },
  });
  if (totalMemberships <= 1) {
    return Response.json(
      { error: "last_household", message: "Letzter Haushalt kann nicht gelöscht werden" },
      { status: 400 },
    );
  }

  // If the deleted household was the user's active one, null it out
  // first so ensureActiveHousehold below picks a real survivor.
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

  await db.household.delete({ where: { id } });

  // Re-pick a new active id (existing members of OTHER households).
  const newActive = await ensureActiveHousehold(auth.userId);
  return Response.json({ ok: true, activeHouseholdId: newActive });
}
