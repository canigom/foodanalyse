// /api/meals/:id — DELETE and PATCH a single meal.
//
// Tenant check: every query is scoped to (id, userId) so a user can never
// touch someone else's row even if they guess the cuid. We return 404 (not
// 403) when the row doesn't match — saying "forbidden" would confirm the
// id exists, leaking it.
//
// PATCH semantics: a portionMultiplier in the body multiplies the
// already-stored calories/macros. The "old multiplier" is implicit (1.0
// from the user's perspective — nutrition stored in the row IS the current
// portion). So a multiplier of 1.5 means "scale current values by 1.5x".
//
// Note: in Next.js 16 the params object is a Promise, hence the await.

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { LIMITS } from "@/lib/limits";

export const runtime = "nodejs";

const PatchSchema = z
  .object({
    portionMultiplier: z.number().positive().max(5).optional(),
    notes: z.string().max(LIMITS.recipeDescription).nullable().optional(),
    dishName: z.string().min(1).max(LIMITS.recipeName).optional(),
  })
  .refine(
    (v) =>
      v.portionMultiplier !== undefined ||
      v.notes !== undefined ||
      v.dishName !== undefined,
    { message: "At least one field must be provided" },
  );

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const { id } = await ctx.params;

  const result = await db.meal.deleteMany({
    where: { id, userId: auth.userId },
  });

  if (result.count === 0) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
}

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

  // Tenant-check via findFirst so we can apply multiplier-based math.
  const existing = await db.meal.findFirst({
    where: { id, userId: auth.userId },
  });
  if (!existing) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const update: {
    dishName?: string;
    notes?: string | null;
    calories?: number;
    protein?: number;
    carbs?: number;
    fat?: number;
    fiber?: number | null;
  } = {};

  if (parsed.data.dishName !== undefined) update.dishName = parsed.data.dishName;
  if (parsed.data.notes !== undefined) update.notes = parsed.data.notes;

  if (parsed.data.portionMultiplier !== undefined) {
    const m = parsed.data.portionMultiplier;
    const round1 = (n: number) => Math.round(n * 10) / 10;
    update.calories = Math.round(existing.calories * m);
    update.protein = round1(existing.protein * m);
    update.carbs = round1(existing.carbs * m);
    update.fat = round1(existing.fat * m);
    update.fiber = existing.fiber !== null ? round1(existing.fiber * m) : null;
  }

  const meal = await db.meal.update({
    where: { id },
    data: update,
  });

  return Response.json({ meal });
}
