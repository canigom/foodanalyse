// /api/inventory — GET (list every item in the user's active household)
// + POST (add one to the active household).
//
// Auth required: items are now Household-scoped (Phase 3) but legacy rows
// from before the migration still carry only userId. We treat any row
// where userId === auth.userId AND (householdId === activeHouseholdId OR
// householdId === null) as belonging to the active view. This is the
// "read-time fallback" migration strategy — no batch backfill, the rows
// simply land in the user's current household next time they're touched.
//
// On POST we always stamp the new row's householdId with the user's
// active household so future reads stay scoped without depending on the
// fallback.
//
// List ordering: expiresAt asc with nulls LAST. Postgres orders nulls
// first by default; we flip that with `{ sort: 'asc', nulls: 'last' }`.
//
// Limits: name is reasonable as a recipe-name (200 chars). notes reuses
// the recipe-description cap (2000) — generous since users sometimes
// paste in storage instructions. quantity is bounded to a sane max so a
// fat-finger ("99999") doesn't break the UI layout.

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { LIMITS } from "@/lib/limits";
import { ensureActiveHousehold } from "@/lib/household";

export const runtime = "nodejs";

const UNITS = ["stk", "g", "kg", "ml", "l"] as const;

// Strict ISO datetime parse — z.string().datetime() rejects "2026-05-09"
// without a time component, which is fine: the iOS client always sends
// either a full ISO string from `new Date().toISOString()` or null.
const isoDate = z
  .string()
  .datetime({ offset: true })
  .or(z.string().datetime());

const InventoryBodySchema = z.object({
  name: z.string().min(1).max(LIMITS.recipeName),
  quantity: z.number().nonnegative().max(100_000).optional(),
  unit: z.enum(UNITS).optional(),
  expiresAt: isoDate.nullable().optional(),
  barcode: z.string().max(64).optional(),
  brand: z.string().max(LIMITS.recipeName).optional(),
  imageUrl: z.string().url().max(2048).optional(),
  notes: z.string().max(LIMITS.recipeDescription).optional(),
});

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  // Lazy-create the user's personal household + pick activeHouseholdId
  // before scoping the read. Brand-new accounts hit this on their first
  // inventory load (or first /api/households call, whichever comes first).
  const activeHouseholdId = await ensureActiveHousehold(auth.userId);

  // Membership-scoped read: the caller could be looking at someone else's
  // household (they joined via invite). For shared households we want to
  // see the OTHER members' items too — match on householdId, not userId.
  // Legacy null-householdId rows belonging to the auth user fall back
  // into the view as well so old data isn't lost.
  const items = await db.inventoryItem.findMany({
    where: {
      OR: [
        { householdId: activeHouseholdId },
        { householdId: null, userId: auth.userId },
      ],
    },
    orderBy: [
      { expiresAt: { sort: "asc", nulls: "last" } },
      { addedAt: "desc" },
    ],
  });

  return Response.json({ items });
}

export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const activeHouseholdId = await ensureActiveHousehold(auth.userId);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = InventoryBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const item = await db.inventoryItem.create({
    data: {
      userId: auth.userId,
      householdId: activeHouseholdId,
      name: parsed.data.name,
      quantity: parsed.data.quantity ?? null,
      unit: parsed.data.unit ?? null,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
      barcode: parsed.data.barcode ?? null,
      brand: parsed.data.brand ?? null,
      imageUrl: parsed.data.imageUrl ?? null,
      notes: parsed.data.notes ?? null,
      notificationIds: [],
    },
  });

  return Response.json({ item }, { status: 201 });
}
