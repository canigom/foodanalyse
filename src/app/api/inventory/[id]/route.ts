// /api/inventory/:id — PATCH (partial update) + DELETE.
//
// Tenant check (Phase 3): the caller may be the original author OR any
// other member of the item's household — shared households need shared
// edit access. We accept the row when:
//   - userId === auth.userId (author), OR
//   - the item's householdId is one the auth user is a member of, OR
//   - legacy: householdId is null AND userId === auth.userId.
// On a miss we return 404 (not 403) so a guessed id stays
// indistinguishable from a wrong one.
//
// PATCH semantics: every field is optional; only the keys present in the
// body are touched. expiresAt accepts `null` to clear an existing date so
// the iOS edit screen can drop the date with one PATCH instead of a
// DELETE+POST round-trip.
//
// notificationIds replaces (not merges) the array — iOS computes the new
// set client-side after scheduling and sends the full list back.
//
// Note: in Next.js 16 the params object is a Promise, hence the await.

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { LIMITS } from "@/lib/limits";
import { requireMembership } from "@/lib/household";

export const runtime = "nodejs";

const UNITS = ["stk", "g", "kg", "ml", "l"] as const;
const isoDate = z
  .string()
  .datetime({ offset: true })
  .or(z.string().datetime());

const PatchSchema = z
  .object({
    name: z.string().min(1).max(LIMITS.recipeName).optional(),
    // Explicit null clears the value on the server; undefined leaves it
    // alone. zod's .nullable().optional() encodes both states.
    quantity: z.number().nonnegative().max(100_000).nullable().optional(),
    unit: z.enum(UNITS).nullable().optional(),
    expiresAt: isoDate.nullable().optional(),
    barcode: z.string().max(64).nullable().optional(),
    brand: z.string().max(LIMITS.recipeName).nullable().optional(),
    imageUrl: z.string().url().max(2048).nullable().optional(),
    notes: z.string().max(LIMITS.recipeDescription).nullable().optional(),
    notificationIds: z.array(z.string().max(128)).max(50).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
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

  // Tenant check — confirm the caller is allowed to touch this row before
  // updating. Allowed if they authored it OR they're a member of the
  // item's household (shared edit access). Legacy rows with no
  // householdId fall through the userId check.
  const existing = await db.inventoryItem.findUnique({
    where: { id },
    select: { id: true, userId: true, householdId: true },
  });
  if (!existing) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const allowed =
    existing.userId === auth.userId ||
    (existing.householdId !== null &&
      (await requireMembership(existing.householdId, auth.userId)) !== null);
  if (!allowed) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Build the update object explicitly so undefined keys don't make it
  // into the Prisma payload (Prisma treats undefined as "skip", but being
  // explicit also documents the null-vs-skip semantics).
  const data: Record<string, unknown> = {};
  const p = parsed.data;
  if (p.name !== undefined) data.name = p.name;
  if (p.quantity !== undefined) data.quantity = p.quantity;
  if (p.unit !== undefined) data.unit = p.unit;
  if (p.expiresAt !== undefined) {
    data.expiresAt = p.expiresAt === null ? null : new Date(p.expiresAt);
  }
  if (p.barcode !== undefined) data.barcode = p.barcode;
  if (p.brand !== undefined) data.brand = p.brand;
  if (p.imageUrl !== undefined) data.imageUrl = p.imageUrl;
  if (p.notes !== undefined) data.notes = p.notes;
  if (p.notificationIds !== undefined) data.notificationIds = p.notificationIds;

  const item = await db.inventoryItem.update({
    where: { id },
    data,
  });

  return Response.json({ item });
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const { id } = await ctx.params;

  // Same tenant rule as PATCH: author OR co-member of the item's
  // household may delete. Legacy null-householdId rows fall back to the
  // author-only check.
  const existing = await db.inventoryItem.findUnique({
    where: { id },
    select: { id: true, userId: true, householdId: true },
  });
  if (!existing) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const allowed =
    existing.userId === auth.userId ||
    (existing.householdId !== null &&
      (await requireMembership(existing.householdId, auth.userId)) !== null);
  if (!allowed) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  await db.inventoryItem.delete({ where: { id } });
  return Response.json({ ok: true });
}
