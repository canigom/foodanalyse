// /api/inventory — GET (list every item the user owns) + POST (add one).
//
// Auth required: items are user-scoped via InventoryItem.userId. There is
// no anonymous flow; an unauthenticated caller simply has nowhere to attach
// the row, so we 401 rather than allowing silent loss.
//
// List ordering: expiresAt asc with nulls LAST. Postgres orders nulls first
// by default; we flip that with a raw NULLS LAST hint via Prisma's
// `{ sort: 'asc', nulls: 'last' }` option. The iOS list re-groups items by
// urgency client-side, but the server-side ordering keeps the "most urgent
// first" ordering inside each group consistent.
//
// Limits: name is reasonable as a recipe-name (200 chars). notes reuses
// the recipe-description cap (2000) — generous since users sometimes paste
// in storage instructions. quantity is bounded to a sane max so a fat-
// finger ("99999") doesn't break the UI layout.

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { LIMITS } from "@/lib/limits";

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

  const items = await db.inventoryItem.findMany({
    where: { userId: auth.userId },
    // Most-urgent first; items without a date sink to the bottom so the
    // dated rows surface before the user has to scroll.
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
