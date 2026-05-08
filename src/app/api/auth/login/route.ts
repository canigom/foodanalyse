// POST /api/auth/login
//
// Custom login that returns a JWT bearer token suitable for the iOS app's
// Authorization header. NextAuth's session cookies are browser-only — this
// endpoint is the iOS-friendly equivalent.
//
// Always responds with the same generic 401 message on bad credentials so
// it can't be used as an account-existence oracle.

import { z } from "zod";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { signSessionToken } from "@/lib/jwt";
import { LIMITS } from "@/lib/limits";

export const runtime = "nodejs";

const LoginSchema = z.object({
  email: z.string().email().max(LIMITS.email),
  password: z.string().min(1).max(LIMITS.password),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = LoginSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input" }, { status: 400 });
  }

  const email = parsed.data.email.toLowerCase().trim();
  const user = await db.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) {
    return Response.json({ error: "Invalid email or password" }, { status: 401 });
  }

  const ok = await verifyPassword(parsed.data.password, user.passwordHash);
  if (!ok) {
    return Response.json({ error: "Invalid email or password" }, { status: 401 });
  }

  const token = await signSessionToken({ userId: user.id, email: user.email });
  return Response.json({
    token,
    user: { id: user.id, email: user.email, name: user.name },
  });
}
