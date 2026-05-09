// POST /api/analyze
//
// The Claude vision proxy. **Auth required** — we route the iOS app through
// onboarding + login before the camera flow opens, so there should never be
// an anonymous caller hitting this endpoint. Reject with 401 instead of
// silently allowing it.
//
// Logged-in users always have their saved server-side preferences applied
// (so a stale iOS bundle can't override prefs the user updated elsewhere).
//
// We forward to claude-sonnet-4-6 via the Anthropic Messages API using a
// hand-rolled fetch wrapper (see src/lib/claude.ts). Output is validated
// with zod before being returned to the client — bad/non-JSON output
// from the model surfaces as a 502 rather than a confusing 200.

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { analyzeFridge, ClaudeError, CLAUDE_MODELS } from "@/lib/claude";
import { classifyImage } from "@/lib/classify";
import { consume } from "@/lib/rate-limit";
import { LIMITS } from "@/lib/limits";
import { isInTrial, FREE_TIER_LIMITS } from "@/lib/trial";

export const runtime = "nodejs";
// Vision calls into Claude can take 10-25s; bump the function timeout to
// avoid Vercel-style early termination. Self-hosted Node has no such
// limit, but setting it explicitly is harmless and self-documenting.
export const maxDuration = 60;

const StringArray = z.array(z.string().max(LIMITS.preferenceItem)).max(20);

const PrefsSchema = z.object({
  dietary: StringArray.optional(),
  cuisines: StringArray.optional(),
  dislikes: StringArray.optional(),
  occasion: StringArray.optional(),
  equipment: StringArray.optional(),
  time: StringArray.optional(),
  difficulty: StringArray.optional(),
  allergies: StringArray.optional(),
});

const AnalyzeBodySchema = z.object({
  imageBase64: z.string().min(100).max(LIMITS.imageBase64),
  preferences: PrefsSchema.optional(),
});

type Prefs = {
  dietary: string[];
  cuisines: string[];
  dislikes: string[];
  occasion: string[];
  equipment: string[];
  time: string[];
  difficulty: string[];
  allergies: string[];
};

const EMPTY_PREFS: Prefs = {
  dietary: [],
  cuisines: [],
  dislikes: [],
  occasion: [],
  equipment: [],
  time: [],
  difficulty: [],
  allergies: [],
};

export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = AnalyzeBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Tier check — fetch the user's createdAt to decide trial vs free.
  // Trial users get Sonnet + the 30/h ceiling only; free users get Haiku
  // + a 1/day cap that gates the upgrade prompt.
  const userRow = await db.user.findUnique({
    where: { id: auth.userId },
    select: { createdAt: true },
  });
  if (!userRow) {
    // Token valid but row gone — bounce as 401 so iOS resets auth.
    return Response.json({ error: "User no longer exists" }, { status: 401 });
  }
  const inTrial = isInTrial(userRow);

  // Daily free-tier gate. Hits BEFORE the global hourly bucket so a free
  // user already at their daily limit never burns a Claude call.
  if (!inTrial) {
    const day = consume("free-fridge", auth.userId);
    if (!day.ok) {
      return Response.json(
        {
          error: "trial_expired_upgrade",
          retryAfterSec: day.retryAfterSec,
          limits: FREE_TIER_LIMITS,
        },
        {
          status: 402,
          headers: {
            "Retry-After": String(day.retryAfterSec),
            "X-RateLimit-Limit": String(day.limit),
            "X-RateLimit-Remaining": "0",
          },
        },
      );
    }
  }

  // Global per-hour ceiling — applies to trial + free + premium alike as
  // API abuse protection. These calls cost real money.
  const rate = consume("analyze-user", auth.userId);
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

  // Always use server-side preferences — body.preferences is ignored even if
  // a stale iOS bundle still sends it. Server is the source of truth.
  let preferences: Prefs = EMPTY_PREFS;
  const row = await db.preference.findUnique({
    where: { userId: auth.userId },
    select: {
      dietary: true,
      cuisines: true,
      dislikes: true,
      occasion: true,
      equipment: true,
      time: true,
      difficulty: true,
      allergies: true,
    },
  });
  if (row) preferences = { ...EMPTY_PREFS, ...row };

  // Cheap pre-flight: if the image is clearly a finished plate of food,
  // short-circuit and tell the client to redirect to the meals section
  // before we burn a Sonnet call generating recipes from a dish photo.
  // classifyImage returns "other" on any failure, so the happy path is
  // never blocked by a flaky classifier.
  const detected = await classifyImage(parsed.data.imageBase64);
  // 'meal' → suggest the meal flow. 'other' → reject outright (iOS shows
  // "neither fridge nor meal" alert and asks for a new photo). null means
  // the classifier itself failed — fall through to Sonnet so a flaky
  // Haiku call doesn't block legitimate users.
  if (detected === "meal" || detected === "other") {
    return Response.json(
      { wrongSection: true, suggestedType: detected },
      {
        headers: {
          "X-RateLimit-Limit": String(rate.limit),
          "X-RateLimit-Remaining": String(rate.remaining),
        },
      },
    );
  }

  try {
    const result = await analyzeFridge({
      imageBase64: parsed.data.imageBase64,
      preferences,
      // Trial → Sonnet (full quality). Free → Haiku (cheaper, slightly
      // lower quality output but still good enough for ingredient-to-recipe).
      model: inTrial ? CLAUDE_MODELS.sonnet : CLAUDE_MODELS.haiku,
    });
    return Response.json(
      { ...result, detectedType: detected ?? "fridge" },
      {
        headers: {
          "X-RateLimit-Limit": String(rate.limit),
          "X-RateLimit-Remaining": String(rate.remaining),
        },
      },
    );
  } catch (err) {
    if (err instanceof ClaudeError) {
      // 5xx from upstream → 502; 4xx → 400 (client supplied bad image
      // or oversized payload); 429 → 429 forwarded as-is.
      const status =
        err.status === 429 ? 429 :
        err.status >= 400 && err.status < 500 ? 400 :
        502;
      return Response.json({ error: err.message }, { status });
    }
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
