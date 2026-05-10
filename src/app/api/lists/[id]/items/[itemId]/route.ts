// /api/lists/:id/items/:itemId — PATCH (toggle checked / edit) + DELETE.
//
// Owner OR member can edit any item on a list they belong to. The check
// is a single findFirst that joins through the list's owner/member set,
// then a deleteMany / updateMany scoped to (list, item) so we never
// touch a row we shouldn't.
//
// Toggle semantics: when the client flips `checked` false→true we stamp
// `checkedAt = now()`. The reverse direction clears `checkedAt`. Loose
// audit trail; helpful for the "X erledigt von Y" overview later.

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { LIMITS } from "@/lib/limits";

export const runtime = "nodejs";

const UNITS = ["stk", "g", "kg", "ml", "l"] as const;

const PatchSchema = z
  .object({
    name: z.string().min(1).max(LIMITS.recipeName).optional(),
    // null clears, undefined skips — same shape as the inventory PATCH.
    quantity: z.number().nonnegative().max(100_000).nullable().optional(),
    unit: z.enum(UNITS).nullable().optional(),
    checked: z.boolean().optional(),
    position: z.number().int().nonnegative().max(1_000_000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });

// Look up the (list, item) combo while verifying the caller has access
// (owner OR member of the parent list). Returns the item or null.
async function findAccessibleItem(
  listId: string,
  itemId: string,
  userId: string,
) {
  return db.shoppingListItem.findFirst({
    where: {
      id: itemId,
      listId,
      list: {
        OR: [
          { ownerId: userId },
          { members: { some: { userId } } },
        ],
      },
    },
  });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; itemId: string }> },
) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const { id: listId, itemId } = await ctx.params;

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

  const existing = await findAccessibleItem(listId, itemId, auth.userId);
  if (!existing) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const data: Record<string, unknown> = {};
  const p = parsed.data;
  if (p.name !== undefined) data.name = p.name.trim();
  if (p.quantity !== undefined) data.quantity = p.quantity;
  if (p.unit !== undefined) data.unit = p.unit;
  if (p.position !== undefined) data.position = p.position;
  if (p.checked !== undefined) {
    data.checked = p.checked;
    // Stamp checkedAt on transitions only — re-toggling true→true keeps
    // the original timestamp so the audit trail reads right.
    if (p.checked && !existing.checked) {
      data.checkedAt = new Date();
    } else if (!p.checked) {
      data.checkedAt = null;
    }
  }

  const item = await db.shoppingListItem.update({
    where: { id: itemId },
    data,
  });

  // Touch the parent list so the overview reorders by recency.
  await db.shoppingList.update({
    where: { id: listId },
    data: { updatedAt: new Date() },
  });

  return Response.json({ item });
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string; itemId: string }> },
) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const { id: listId, itemId } = await ctx.params;

  const existing = await findAccessibleItem(listId, itemId, auth.userId);
  if (!existing) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  await db.shoppingListItem.delete({ where: { id: itemId } });

  await db.shoppingList.update({
    where: { id: listId },
    data: { updatedAt: new Date() },
  });

  return Response.json({ ok: true });
}
