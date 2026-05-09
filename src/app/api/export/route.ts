// GET /api/export
//
// DSGVO/GDPR-style data export. Aggregates everything we hold about the
// authenticated user into a single JSON document the client can save,
// share, or email to themselves. Meals are limited to the most recent 365
// days (rows carry inline base64 thumbnails — full history would be huge).
//
// imageBase64 fields are stripped from the export response: they're large
// (1-2 MB each), and the user already has the photos they uploaded in
// their camera roll. Including them would routinely push the export past
// reasonable JSON sizes for sharing via email/Files.

import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";

export const runtime = "nodejs";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: { id: true, email: true, name: true, createdAt: true },
  });
  if (!user) {
    return Response.json({ error: "User no longer exists" }, { status: 401 });
  }

  const since = new Date(Date.now() - 365 * DAY_MS);

  const [profile, preferences, savedRecipes, meals] = await Promise.all([
    db.userProfile.findUnique({
      where: { userId: user.id },
      select: {
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
        updatedAt: true,
      },
    }),
    db.preference.findUnique({
      where: { userId: user.id },
      select: {
        dietary: true,
        cuisines: true,
        dislikes: true,
        occasion: true,
        equipment: true,
        time: true,
        difficulty: true,
        allergies: true,
        updatedAt: true,
      },
    }),
    db.savedRecipe.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        description: true,
        ingredients: true,
        steps: true,
        cookingTimeMinutes: true,
        calories: true,
        protein: true,
        carbs: true,
        fat: true,
        fiber: true,
        createdAt: true,
      },
    }),
    db.meal.findMany({
      where: { userId: user.id, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        dishName: true,
        calories: true,
        protein: true,
        carbs: true,
        fat: true,
        fiber: true,
        portionSize: true,
        ingredients: true,
        notes: true,
        createdAt: true,
      },
    }),
  ]);

  const isoDate = new Date().toISOString().slice(0, 10);
  const payload = {
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    user,
    profile: profile ?? null,
    preferences: preferences ?? null,
    savedRecipes,
    meals,
    mealsWindowDays: 365,
  };

  // Build the response manually so we can attach Content-Disposition and
  // a stable filename for the iOS share sheet.
  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="kochheute-export-${user.id}-${isoDate}.json"`,
    },
  });
}
