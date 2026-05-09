// /api/preferences — GET + PUT
//
// Stores per-user dietary and cuisine preferences plus a free-text
// "dislikes" list and (newer) categorized fields for occasion, equipment,
// preferred time, difficulty, and allergies. /api/analyze pulls these in
// for logged-in users so the recipe suggestions reflect the user's actual
// diet without the iOS client needing to forward them on every request.

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { LIMITS } from "@/lib/limits";

export const runtime = "nodejs";

// Each list capped at 20 items (sane upper bound; UI shows chips).
const StringArray = z.array(z.string().min(1).max(LIMITS.preferenceItem)).max(20);

// Newer fields are optional + default to []; older clients only sending
// dietary/cuisines/dislikes still upsert cleanly.
const PutSchema = z.object({
  dietary: StringArray,
  cuisines: StringArray,
  dislikes: StringArray,
  occasion: StringArray.optional().default([]),
  equipment: StringArray.optional().default([]),
  time: StringArray.optional().default([]),
  difficulty: StringArray.optional().default([]),
  allergies: StringArray.optional().default([]),
});

const SELECT = {
  dietary: true,
  cuisines: true,
  dislikes: true,
  occasion: true,
  equipment: true,
  time: true,
  difficulty: true,
  allergies: true,
} as const;

const EMPTY = {
  dietary: [],
  cuisines: [],
  dislikes: [],
  occasion: [],
  equipment: [],
  time: [],
  difficulty: [],
  allergies: [],
};

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const row = await db.preference.findUnique({
    where: { userId: auth.userId },
    select: SELECT,
  });

  // No row yet → return defaults rather than 404. The iOS UI just shows
  // empty preference sections.
  return Response.json(row ?? EMPTY);
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

  const data = {
    dietary: parsed.data.dietary,
    cuisines: parsed.data.cuisines,
    dislikes: parsed.data.dislikes,
    occasion: parsed.data.occasion,
    equipment: parsed.data.equipment,
    time: parsed.data.time,
    difficulty: parsed.data.difficulty,
    allergies: parsed.data.allergies,
  };

  await db.preference.upsert({
    where: { userId: auth.userId },
    create: { userId: auth.userId, ...data },
    update: data,
  });

  return Response.json({ ok: true });
}
