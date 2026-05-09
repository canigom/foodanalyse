// /api/meals — GET (list meals for a date) + POST (analyze + save a new meal).
//
// Auth is required: meals are user-scoped. Anonymous callers don't have
// anywhere to attach the row, so we 401 rather than allowing it.
//
// POST flow:
//   1. Validate body (image base64 + optional portionMultiplier + notes).
//   2. Rate-limit (30/h/user — same as analyze).
//   3. Call Claude vision with the meal-analysis prompt.
//   4. Multiply nutrition by portionMultiplier (default 1).
//   5. Persist + return.

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { analyzeMeal, ClaudeError } from "@/lib/claude";
import { consume } from "@/lib/rate-limit";
import { LIMITS } from "@/lib/limits";

export const runtime = "nodejs";
// Vision calls take 10-25s — bump default function timeout. Self-hosted
// Node ignores this, but it's harmless and self-documenting.
export const maxDuration = 60;

const DateQuerySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

// portionMultiplier kept loose (0.25..5x) so v1 quick-pick (0.5x..2x) and
// future custom inputs both fit.
const MealBodySchema = z.object({
  imageBase64: z.string().min(100).max(LIMITS.imageBase64),
  portionMultiplier: z.number().positive().max(5).optional(),
  notes: z.string().max(LIMITS.recipeDescription).optional(),
});

// Window for "the requested day" in the user's local time. We don't know the
// user's timezone server-side, so we use UTC days. Close enough for v1; if
// users complain we can ship a tz field on Preference later.
function dayBounds(dateStr: string): { gte: Date; lt: Date } {
  const [y, m, d] = dateStr.split("-").map(Number);
  const gte = new Date(Date.UTC(y, m - 1, d));
  const lt = new Date(Date.UTC(y, m - 1, d + 1));
  return { gte, lt };
}

function todayUtcStr(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

type Totals = {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
};

function sumTotals(meals: Array<{
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number | null;
}>): Totals {
  return meals.reduce<Totals>(
    (acc, m) => ({
      calories: acc.calories + (m.calories ?? 0),
      protein: acc.protein + (m.protein ?? 0),
      carbs: acc.carbs + (m.carbs ?? 0),
      fat: acc.fat + (m.fat ?? 0),
      fiber: acc.fiber + (m.fiber ?? 0),
    }),
    { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 },
  );
}

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const dateParam = url.searchParams.get("date") ?? todayUtcStr();
  const parsedDate = DateQuerySchema.safeParse(dateParam);
  if (!parsedDate.success) {
    return Response.json({ error: "Invalid date" }, { status: 400 });
  }

  const { gte, lt } = dayBounds(parsedDate.data);

  const meals = await db.meal.findMany({
    where: { userId: auth.userId, createdAt: { gte, lt } },
    orderBy: { createdAt: "desc" },
  });

  return Response.json({ meals, totals: sumTotals(meals) });
}

export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = MealBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Same bucket name as recipe analysis would double-count; use a separate
  // key so the user has independent budgets for fridge analysis vs. meal
  // logging. 30/hour user-scoped is the cap (re-using the analyze-user limit).
  const rate = consume("analyze-user", `meals:${auth.userId}`);
  if (!rate.ok) {
    return Response.json(
      {
        error: "Rate limit exceeded (30/hour). Try again later.",
        retryAfterSec: rate.retryAfterSec,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rate.retryAfterSec),
          "X-RateLimit-Limit": String(rate.limit),
          "X-RateLimit-Remaining": "0",
        },
      },
    );
  }

  const multiplier = parsed.data.portionMultiplier ?? 1;

  try {
    const analysis = await analyzeMeal({ imageBase64: parsed.data.imageBase64 });

    // Apply portion multiplier server-side so nothing downstream has to do it.
    // Round calories to int (kcal); keep macros to 1 decimal — matches what
    // the iOS UI displays.
    const round1 = (n: number) => Math.round(n * 10) / 10;
    const calories = Math.round(analysis.calories * multiplier);
    const protein = round1(analysis.protein * multiplier);
    const carbs = round1(analysis.carbs * multiplier);
    const fat = round1(analysis.fat * multiplier);
    const fiber = analysis.fiber !== undefined ? round1(analysis.fiber * multiplier) : null;

    const meal = await db.meal.create({
      data: {
        userId: auth.userId,
        dishName: analysis.dishName,
        portionSize: analysis.portionSize ?? null,
        ingredients: analysis.ingredients,
        notes: parsed.data.notes ?? null,
        // TODO(v2): move imageBase64 to object storage (S3/R2). v1 stores
        // it inline so the client can reuse the photo on Confirm/Detail.
        imageBase64: parsed.data.imageBase64,
        calories,
        protein,
        carbs,
        fat,
        fiber,
      },
    });

    return Response.json(
      { meal },
      {
        status: 201,
        headers: {
          "X-RateLimit-Limit": String(rate.limit),
          "X-RateLimit-Remaining": String(rate.remaining),
        },
      },
    );
  } catch (err) {
    if (err instanceof ClaudeError) {
      const status =
        err.status === 429
          ? 429
          : err.status >= 400 && err.status < 500
            ? 400
            : 502;
      return Response.json({ error: err.message }, { status });
    }
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
