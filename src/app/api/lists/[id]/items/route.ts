// /api/lists/:id/items — POST (add a new item to a list).
//
// Owner OR member can add. Same access pattern as the GET on the parent
// list: the OR clause makes the membership check a single DB round-trip.
//
// We compute `position` server-side as max(position)+1 so a multi-client
// add doesn't collide on a default-zero. Position is loose ordering — the
// iOS client can later PATCH explicit positions for drag-and-drop reorder.

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { LIMITS } from "@/lib/limits";

export const runtime = "nodejs";

const UNITS = ["stk", "g", "kg", "ml", "l"] as const;

const AddItemSchema = z.object({
  // Reuse the recipe-name cap (200 chars) — same shape as InventoryItem.
  name: z.string().min(1).max(LIMITS.recipeName),
  quantity: z.number().nonnegative().max(100_000).optional(),
  unit: z.enum(UNITS).optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const { id: listId } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = AddItemSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Access check — owner OR member of this list. 404 on miss.
  const list = await db.shoppingList.findFirst({
    where: {
      id: listId,
      OR: [
        { ownerId: auth.userId },
        { members: { some: { userId: auth.userId } } },
      ],
    },
    select: { id: true },
  });
  if (!list) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Find the current max position so the new row appends. _max returns
  // null on an empty list — coalesce to 0 so the first item starts at 1.
  const agg = await db.shoppingListItem.aggregate({
    where: { listId },
    _max: { position: true },
  });
  const nextPosition = (agg._max.position ?? 0) + 1;

  const item = await db.shoppingListItem.create({
    data: {
      listId,
      name: parsed.data.name.trim(),
      quantity: parsed.data.quantity ?? null,
      unit: parsed.data.unit ?? null,
      position: nextPosition,
      addedById: auth.userId,
    },
  });

  // Bump the parent list's updatedAt so the overview screen's "newest
  // first" sort surfaces lists with recent activity.
  await db.shoppingList.update({
    where: { id: listId },
    data: { updatedAt: new Date() },
  });

  return Response.json({ item }, { status: 201 });
}
