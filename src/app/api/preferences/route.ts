// /api/preferences — GET + PUT
//
// Stores per-user dietary and cuisine preferences plus a free-text
// "dislikes" list. /api/analyze pulls these in for logged-in users so the
// recipe suggestions reflect the user's actual diet without the iOS
// client needing to forward them on every request.

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { LIMITS } from "@/lib/limits";

export const runtime = "nodejs";

// Each list capped at 20 items (sane upper bound; UI shows chips).
const StringArray = z.array(z.string().min(1).max(LIMITS.preferenceItem)).max(20);

const PutSchema = z.object({
  dietary: StringArray,
  cuisines: StringArray,
  dislikes: StringArray,
});

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const row = await db.preference.findUnique({
    where: { userId: auth.userId },
    select: { dietary: true, cuisines: true, dislikes: true },
  });

  // No row yet → return defaults rather than 404. The iOS UI just shows
  // empty preference sections.
  return Response.json(
    row ?? { dietary: [], cuisines: [], dislikes: [] },
  );
}

export async function PUT(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  await db.preference.upsert({
    where: { userId: auth.userId },
    create: {
      userId: auth.userId,
      dietary: parsed.data.dietary,
      cuisines: parsed.data.cuisines,
      dislikes: parsed.data.dislikes,
    },
    update: {
      dietary: parsed.data.dietary,
      cuisines: parsed.data.cuisines,
      dislikes: parsed.data.dislikes,
    },
  });

  return Response.json({ ok: true });
}
