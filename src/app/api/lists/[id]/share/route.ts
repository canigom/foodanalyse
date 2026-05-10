// /api/lists/:id/share — POST (mint a share token), DELETE (revoke it).
//
// Premium-only. We use the existing `isInTrial` helper as the gate; once
// the IAP / Subscription model lands, the `inTrial || isPremium` check
// falls through cleanly. Free + post-trial users get a 402 with
// `{ error: "premium_only" }` which the iOS client maps to
// PaywallRequiredError → opens the paywall.
//
// Token format: 16-char base32 (Crockford-friendly alphabet, all-caps,
// no I/O/L/U). Generated via crypto.randomBytes for proper entropy.
// Unique-indexed at the DB level so retries on collision are a one-line
// catch-and-retry.
//
// Owner-only on both verbs — sharing is a possessive action; members
// can't re-share a list they joined. (Members joining a list don't
// generate a new token, just a ShoppingListMember row.)

import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { isInTrial } from "@/lib/trial";
import { randomBytes } from "node:crypto";

export const runtime = "nodejs";

// Crockford base32 alphabet — no 0/O/1/I confusion, all-caps. 16 chars
// at log2(32)=5 bits each = 80 bits of entropy, plenty for an unguessable
// short code while still readable / SMS-able.
const BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function generateShareToken(): string {
  const bytes = randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i++) {
    // Map each random byte through the alphabet — modulo bias is
    // irrelevant for 256→32 (256 % 32 === 0).
    out += BASE32_ALPHABET[bytes[i] & 0x1f];
  }
  return out;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const { id } = await ctx.params;

  // Premium gate. Read the user row so we can derive trial state. Once
  // a Subscription model exists, swap `false` for the real premium check.
  const userRow = await db.user.findUnique({
    where: { id: auth.userId },
    select: { createdAt: true },
  });
  if (!userRow) {
    return Response.json({ error: "User no longer exists" }, { status: 401 });
  }

  const inTrial = isInTrial(userRow);
  // TODO(IAP): replace with `inTrial || userRow.subscription?.status === "active"`.
  const isPremium = false;
  if (!inTrial && !isPremium) {
    return Response.json({ error: "premium_only" }, { status: 402 });
  }

  // Owner-only — members can't re-share a list someone else owns.
  const existing = await db.shoppingList.findFirst({
    where: { id, ownerId: auth.userId },
    select: { id: true, shareToken: true },
  });
  if (!existing) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  // Idempotent — if the list already has a token we hand the same one
  // back. Re-rolling on every POST would invalidate links the owner
  // already shared, which is surprising and bad.
  if (existing.shareToken) {
    return Response.json({
      shareToken: existing.shareToken,
      shareUrl: buildShareUrl(existing.shareToken),
    });
  }

  // Generate + persist with a one-shot retry on the (extremely rare)
  // unique-index collision. 80 bits of entropy makes this effectively
  // never happen; the retry is paranoia, not a design pattern.
  let shareToken = generateShareToken();
  try {
    await db.shoppingList.update({
      where: { id },
      data: { shareToken },
    });
  } catch {
    shareToken = generateShareToken();
    await db.shoppingList.update({
      where: { id },
      data: { shareToken },
    });
  }

  return Response.json({
    shareToken,
    shareUrl: buildShareUrl(shareToken),
  });
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const { id } = await ctx.params;

  // Owner-only revoke. We don't paywall the revoke direction — letting
  // someone shut down sharing they no longer want should always work,
  // even if their trial expired.
  const result = await db.shoppingList.updateMany({
    where: { id, ownerId: auth.userId },
    data: { shareToken: null },
  });
  if (result.count === 0) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
}

// Public-facing share URL. Real domain TBD — placeholder for now so the
// iOS share sheet can render a copyable link. The path component is the
// share token itself; once kochheute.app is live the route will resolve
// to a deep-link handler that calls POST /api/lists/join.
function buildShareUrl(token: string): string {
  return `https://kochheute.app/list/${token}`;
}
