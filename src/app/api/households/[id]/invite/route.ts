// /api/households/:id/invite — POST (mint code, owner+premium-gated) +
// DELETE (revoke, owner-only).
//
// Mint regenerates the code on every call, replacing any existing one —
// simplest UX (the iOS detail screen has a single "Code generieren"
// button that doubles as "rotate").
//
// Codes are 8-char base32 with a 7-day TTL. We always try to mint a
// unique code on the first attempt (the alphabet is 32^8 ≈ 1T) and only
// retry on the unique-violation. Three attempts is plenty.

import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { generateInviteCode, INVITE_TTL_MS } from "@/lib/household";
import { isInTrial } from "@/lib/trial";
import { Prisma } from "@prisma/client";

export const runtime = "nodejs";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const { id } = await ctx.params;

  // Premium-gate. Any owner can rename their household for free, but
  // generating an invite (= multi-user feature) is the upsell trigger.
  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: { id: true, createdAt: true },
  });
  if (!user) {
    return Response.json({ error: "User no longer exists" }, { status: 401 });
  }
  if (!isInTrial(user)) {
    return Response.json(
      { error: "premium_only", message: "Einladungen nur in Premium" },
      { status: 402 },
    );
  }

  const existing = await db.household.findFirst({
    where: { id, ownerId: auth.userId },
    select: { id: true },
  });
  if (!existing) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  // Retry on unique-collision — 32^8 means in practice we'll hit on the
  // first try, but better safe than 500-ing on a freak collision.
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateInviteCode();
    try {
      const updated = await db.household.update({
        where: { id },
        data: { inviteCode: code, inviteExpiresAt: expiresAt },
        select: { inviteCode: true, inviteExpiresAt: true },
      });
      return Response.json({
        inviteCode: updated.inviteCode,
        expiresAt: updated.inviteExpiresAt?.toISOString() ?? null,
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        continue;
      }
      throw err;
    }
  }

  return Response.json(
    { error: "Failed to generate unique invite code" },
    { status: 500 },
  );
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const { id } = await ctx.params;

  const existing = await db.household.findFirst({
    where: { id, ownerId: auth.userId },
    select: { id: true },
  });
  if (!existing) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  await db.household.update({
    where: { id },
    data: { inviteCode: null, inviteExpiresAt: null },
  });
  return Response.json({ ok: true });
}
