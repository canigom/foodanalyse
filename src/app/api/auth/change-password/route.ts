// POST /api/auth/change-password
//
// Authenticated password change for the iOS app. The caller submits their
// current password (re-auth) plus a new one; we verify the current via
// bcrypt, hash the new, and update the User row. Existing JWT stays valid —
// no token rotation in v1.
//
// Wrong-current-password is 401 with a localized message so the client can
// surface it inline. All input length-capped via LIMITS.

import { z } from "zod";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/password";
import { requireUser } from "@/lib/auth-bearer";
import { LIMITS } from "@/lib/limits";

export const runtime = "nodejs";

const Schema = z.object({
  currentPassword: z.string().min(1).max(LIMITS.password),
  newPassword: z.string().min(LIMITS.passwordMin).max(LIMITS.password),
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

  const parsed = Schema.safeParse(body);
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
  // Token was valid but user was deleted, or it's a Google-only account
  // with no password. Either way, can't change a password we don't have.
  if (!user || !user.passwordHash) {
    return Response.json(
      { error: "Aktuelles Passwort ist falsch." },
      { status: 401 },
    );
  }

  const ok = await verifyPassword(parsed.data.currentPassword, user.passwordHash);
  if (!ok) {
    return Response.json(
      { error: "Aktuelles Passwort ist falsch." },
      { status: 401 },
    );
  }

  const newHash = await hashPassword(parsed.data.newPassword);
  await db.user.update({
    where: { id: user.id },
    data: { passwordHash: newHash },
  });

  return Response.json({ ok: true });
}
