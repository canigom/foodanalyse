// /api/lists/join — POST { shareToken } → adds the caller as a member.
//
// The opposite end of the /share flow: once an owner has minted a token,
// any signed-in user can join the list by POSTing the token here. We
// look the list up by shareToken (unique-indexed → O(1)), then upsert
// a ShoppingListMember row keyed on (listId, userId) so a re-join is a
// no-op.
//
// Joining is NOT premium-gated — only the *creating* of share tokens
// is. The asymmetric gate matches the product spec: paying users open
// up the list, and any free user they invite can use it. Otherwise
// premium accounts couldn't actually share with their family.
//
// If the token doesn't match anything → 404. If the caller is the owner
// of the list (already has implicit access) → 200 with the list, no
// extra membership row created.

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";

export const runtime = "nodejs";

const JoinSchema = z.object({
  // 16-char base32 (Crockford-friendly). We don't enforce the alphabet
  // here — the unique index does the actual matching. Length cap is a
  // sanity check against fat-finger / DoS payloads.
  shareToken: z.string().min(1).max(64),
});

export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = JoinSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Tokens are stored uppercase by the share endpoint; accept lowercase
  // input from users typing the code in by hand.
  const token = parsed.data.shareToken.trim().toUpperCase();

  const list = await db.shoppingList.findUnique({
    where: { shareToken: token },
    select: { id: true, ownerId: true },
  });
  if (!list) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Owner already has access — no membership row needed. Return the
  // hydrated list anyway so the iOS client can navigate straight to it.
  if (list.ownerId !== auth.userId) {
    // Idempotent membership upsert. The (listId, userId) unique index
    // makes the re-join case a no-op.
    await db.shoppingListMember.upsert({
      where: {
        listId_userId: { listId: list.id, userId: auth.userId },
      },
      create: { listId: list.id, userId: auth.userId },
      update: {},
    });
  }

  // Return the freshly-hydrated list so the iOS client can route into
  // the detail screen without an extra GET.
  const hydrated = await db.shoppingList.findUnique({
    where: { id: list.id },
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

  return Response.json({ list: hydrated });
}
