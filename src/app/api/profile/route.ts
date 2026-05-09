// /api/profile — GET + PUT
//
// User nutrition profile + app settings captured during onboarding and
// editable from the iOS profile screen. Kept separate from /api/preferences
// (which is strictly recipe-flavor preferences) so the two concepts don't
// tangle. Every field is optional: onboarding can be skipped entirely, and
// the iOS client only sends what the user filled in.

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";

export const runtime = "nodejs";

// All fields optional + nullable. The iOS client builds a partial payload
// from whatever it has locally; missing fields just stay null.
const PutSchema = z.object({
  sex: z.enum(["m", "f", "d"]).nullable().optional(),
  age: z.number().int().min(10).max(120).nullable().optional(),
  heightCm: z.number().int().min(50).max(280).nullable().optional(),
  weightKg: z.number().min(20).max(500).nullable().optional(),
  targetWeightKg: z.number().min(20).max(500).nullable().optional(),
  activityLevel: z
    .enum(["sedentary", "light", "moderate", "heavy", "athlete"])
    .nullable()
    .optional(),
  goal: z.enum(["lose", "maintain", "gain"]).nullable().optional(),
  dailyCalorieTarget: z.number().int().min(800).max(8000).nullable().optional(),
  dailyCalorieTargetOverride: z.boolean().optional(),
  proteinTargetG: z.number().int().min(0).max(600).nullable().optional(),
  carbsTargetG: z.number().int().min(0).max(1200).nullable().optional(),
  fatTargetG: z.number().int().min(0).max(400).nullable().optional(),
  units: z.enum(["metric", "imperial"]).nullable().optional(),
  onboardingCompleted: z.boolean().optional(),
});

const SELECT = {
  sex: true,
  age: true,
  heightCm: true,
  weightKg: true,
  targetWeightKg: true,
  activityLevel: true,
  goal: true,
  dailyCalorieTarget: true,
  dailyCalorieTargetOverride: true,
  proteinTargetG: true,
  carbsTargetG: true,
  fatTargetG: true,
  units: true,
  onboardingCompleted: true,
} as const;

const EMPTY = {
  sex: null,
  age: null,
  heightCm: null,
  weightKg: null,
  targetWeightKg: null,
  activityLevel: null,
  goal: null,
  dailyCalorieTarget: null,
  dailyCalorieTargetOverride: false,
  proteinTargetG: null,
  carbsTargetG: null,
  fatTargetG: null,
  units: null,
  onboardingCompleted: false,
};

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const row = await db.userProfile.findUnique({
    where: { userId: auth.userId },
    select: SELECT,
  });

  // No row yet → return defaults rather than 404. The iOS UI just shows
  // empty profile sections.
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

  // Strip undefined keys so we don't accidentally overwrite stored values
  // with nulls when the client only sends a partial patch.
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v !== undefined) data[k] = v;
  }

  await db.userProfile.upsert({
    where: { userId: auth.userId },
    create: { userId: auth.userId, ...data },
    update: data,
  });

  return Response.json({ ok: true });
}
