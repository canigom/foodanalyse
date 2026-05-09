// GET /api/me
//
// Returns the authenticated user's basic profile. The iOS app calls this
// on launch to validate that its stored bearer token is still good — the
// 401 lets it know to bounce back to the login screen.
//
// DELETE /api/me
//
// Permanently deletes the authenticated user's account. Requires the
// password as re-auth in the body so a stolen token alone can't nuke an
// account. Prisma cascades the delete to all child rows (Preference,
// UserProfile, SavedRecipe, Meal, Account, Session) per schema's
// onDelete: Cascade. Client should clear local data + log out after a 200.

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { verifyPassword } from "@/lib/password";
import { LIMITS } from "@/lib/limits";

export const runtime = "nodejs";

const DeleteSchema = z.object({
  password: z.string().min(1).max(LIMITS.password),
});

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: { id: true, email: true, name: true },
  });
  if (!user) {
    // Token was valid but the user has been deleted (DSGVO request, manual
    // cleanup, etc.). Treat as an expired session.
    return Response.json({ error: "User no longer exists" }, { status: 401 });
  }

  return Response.json({ user });
}

export async function DELETE(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = DeleteSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: { id: true, passwordHash: true },
  });
  // Account already gone, or Google-only account with no password —
  // either way reject so we never destructively delete without re-auth.
  if (!user || !user.passwordHash) {
    return Response.json({ error: "Passwort ist falsch." }, { status: 401 });
  }

  const ok = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!ok) {
    return Response.json({ error: "Passwort ist falsch." }, { status: 401 });
  }

  // Cascades to UserProfile, Preference, SavedRecipe, Meal, Account,
  // Session via onDelete: Cascade in schema.prisma.
  await db.user.delete({ where: { id: user.id } });

  return Response.json({ ok: true });
}
