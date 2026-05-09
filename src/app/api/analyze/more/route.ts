// POST /api/analyze/more
//
// Premium-only follow-up endpoint. After /api/analyze returns 3 recipes,
// the iOS client lets the user tap "Mehr Rezepte vorschlagen" to get 3
// MORE different recipes from the same fridge photo. We re-call the
// Claude vision endpoint with the original image plus an exclusion list
// of the already-shown recipe names so the model picks new ones.
//
// Gating: only trial users (and eventually real "premium" subs once IAP
// lands) get past this route. Free / post-trial users hit a 402 with
// `{ error: "premium_only" }` so the iOS client can route to the paywall.
//
// Model selection mirrors /api/analyze in spirit but inverted:
//   - Trial → Sonnet (full quality "wow" tier — they're evaluating us)
//   - Premium → Haiku (cost-optimised — paying customers get unlimited
//     calls so we can't burn Sonnet on every tap; Haiku is plenty good
//     at recipe generation when given a good photo)
//
// Body shape mirrors /analyze plus `existingRecipeNames`. The route only
// returns `{ recipes }` — the client already has `ingredients` from the
// initial analyze call.

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { analyzeFridgeMore, ClaudeError, CLAUDE_MODELS } from "@/lib/claude";
import { consume } from "@/lib/rate-limit";
import { LIMITS } from "@/lib/limits";
import { isInTrial } from "@/lib/trial";

export const runtime = "nodejs";
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

const MoreBodySchema = z.object({
  imageBase64: z.string().min(100).max(LIMITS.imageBase64),
  // Names of the 3 (or so) recipes the client already has on screen. Used
  // to build the exclusion line in the prompt. We cap at a sane upper
  // bound so a buggy client can't pad the prompt with megabytes of names.
  existingRecipeNames: z.array(z.string().min(1).max(LIMITS.recipeName)).max(20),
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

  const parsed = MoreBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Tier gate — fetch the user row so we can check trial status.
  // No real "premium" subscription model exists yet, but we leave the
  // hook in place so the route lights up automatically once the
  // Subscription table lands. For now only trial users pass.
  const userRow = await db.user.findUnique({
    where: { id: auth.userId },
    select: { createdAt: true },
  });
  if (!userRow) {
    return Response.json({ error: "User no longer exists" }, { status: 401 });
  }

  const inTrial = isInTrial(userRow);
  // TODO(IAP): once the Subscription model exists, replace this with
  // `inTrial || userRow.subscription?.status === "active"`. Until then
  // any non-trial user is "free" and gets the paywall.
  const isPremium = false;
  const allowed = inTrial || isPremium;

  if (!allowed) {
    // 402 Payment Required — the iOS client maps this to PaywallRequiredError
    // and shows the paywall instead of an error alert.
    return Response.json(
      { error: "premium_only" },
      { status: 402 },
    );
  }

  // Same global per-hour ceiling as /analyze. This is API abuse protection
  // — applies to trial + premium alike. Without it a single user could
  // tap "more" 100 times in a minute and burn $5 of Claude.
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

  // Server-side preferences win — same rule as /api/analyze. body.preferences
  // is accepted for shape compatibility but ignored.
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

  try {
    // Trial → Sonnet (wow factor). Premium → Haiku (cost optimisation —
    // paying customers tap this button a lot and we can't burn Sonnet
    // on each call). Free users never reach this branch (gated above).
    const model = isPremium ? CLAUDE_MODELS.haiku : CLAUDE_MODELS.sonnet;
    const result = await analyzeFridgeMore({
      imageBase64: parsed.data.imageBase64,
      existingRecipeNames: parsed.data.existingRecipeNames,
      preferences,
      model,
    });
    // Discard ingredients — the client already has them from the original
    // /api/analyze call. Only return the new recipes.
    return Response.json(
      { recipes: result.recipes },
      {
        headers: {
          "X-RateLimit-Limit": String(rate.limit),
          "X-RateLimit-Remaining": String(rate.remaining),
        },
      },
    );
  } catch (err) {
    if (err instanceof ClaudeError) {
      const status =
        err.status === 429 ? 429 :
        err.status >= 400 && err.status < 500 ? 400 :
        502;
      return Response.json({ error: err.message }, { status });
    }
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
}
