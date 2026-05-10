// /api/lists/:id — GET (full hydrated list), PATCH (rename, owner-only),
// DELETE (owner-only).
//
// Tenant check: GET allows owner OR member; PATCH + DELETE are
// owner-only. On a permission miss we return 404, not 403, so a guessed
// id stays indistinguishable from a wrong one.
//
// Note: in Next.js 16 the params object is a Promise, hence the await.

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { LIMITS } from "@/lib/limits";

export const runtime = "nodejs";

const PatchSchema = z
  .object({
    name: z.string().min(1).max(LIMITS.recipeName).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const { id } = await ctx.params;

  const list = await db.shoppingList.findFirst({
    where: {
      id,
      OR: [
        { ownerId: auth.userId },
        { members: { some: { userId: auth.userId } } },
      ],
    },
    include: {
      items: {
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      },
      members: {
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
      },
    },
  });

  if (!list) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  return Response.json({ list });
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

  // Owner-only — members can edit items but not rename the list itself.
  const existing = await db.shoppingList.findFirst({
    where: { id, ownerId: auth.userId },
    select: { id: true },
  });
  if (!existing) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name.trim();

  const list = await db.shoppingList.update({
    where: { id },
    data,
    include: {
      items: {
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      },
      members: {
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
      },
    },
  });

  return Response.json({ list });
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const { id } = await ctx.params;

  // Owner-only. deleteMany so a non-owner just sees count===0 and we
  // return 404 — same indistinguishability as the GET 404 above.
  const result = await db.shoppingList.deleteMany({
    where: { id, ownerId: auth.userId },
  });
  if (result.count === 0) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
