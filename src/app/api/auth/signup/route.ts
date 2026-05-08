// POST /api/auth/signup
//
// Custom signup for the iOS app. NextAuth doesn't ship a registration
// endpoint — it only handles sign-in — so we expose this one. After
// signup the iOS client calls /api/auth/login to obtain a bearer token.
//
// 409 is returned for an existing email so the client can show a
// localized "email already registered" message.

import { z } from "zod";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/password";
import { LIMITS } from "@/lib/limits";

export const runtime = "nodejs";

const SignupSchema = z.object({
  email: z.string().email().max(LIMITS.email),
  password: z.string().min(LIMITS.passwordMin).max(LIMITS.password),
  name: z.string().max(LIMITS.name).optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = SignupSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const email = parsed.data.email.toLowerCase().trim();
  const name = parsed.data.name?.trim() || null;

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    return Response.json({ error: "Email already registered" }, { status: 409 });
  }

  await db.user.create({
    data: {
      email,
      name,
      passwordHash: await hashPassword(parsed.data.password),
    },
  });

  return Response.json({ ok: true }, { status: 201 });
}
