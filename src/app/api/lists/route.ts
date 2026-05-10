// /api/lists — GET (list everything the user can see) + POST (create a list).
//
// Phase 2 (Einkaufslisten). Free for everyone for the local + cross-device
// sync use case; the *sharing* part (POST /api/lists/:id/share) is the
// premium-gated bit. Just owning + reading + editing your own lists is
// available on every tier.
//
// GET returns lists the user owns OR is a member of. We hydrate `items`
// and `members` upfront so the iOS overview screen can render counts /
// "X erledigt von Y" without follow-up calls.
//
// Auth required — there is no anonymous shopping list, the row needs an
// owner. Unauthenticated callers get 401 and bounce.

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { LIMITS } from "@/lib/limits";

export const runtime = "nodejs";

const CreateBodySchema = z.object({
  // Reuse the recipe-name cap (200 chars). User-supplied names like
  // "Wocheneinkauf" or "Geburtstagsparty 12.05." comfortably fit.
  name: z.string().min(1).max(LIMITS.recipeName),
});

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const lists = await db.shoppingList.findMany({
    where: {
      OR: [
        { ownerId: auth.userId },
        { members: { some: { userId: auth.userId } } },
      ],
    },
    // Newest list first — same convention as saved recipes / meals. Items
    // ordered by position then createdAt so unsaved (position=0) entries
    // append at the end while explicit reorders take precedence.
    orderBy: { updatedAt: "desc" },
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

  return Response.json({ lists });
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

  const parsed = CreateBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const list = await db.shoppingList.create({
    data: {
      ownerId: auth.userId,
      name: parsed.data.name.trim(),
    },
    include: {
      items: true,
      members: {
        include: {
          user: { select: { id: true, email: true, name: true } },
        },
      },
    },
  });

  return Response.json({ list }, { status: 201 });
}
