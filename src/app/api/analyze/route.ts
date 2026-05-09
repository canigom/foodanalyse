// POST /api/analyze
//
// The Claude vision proxy. Auth is OPTIONAL — anonymous users get a much
// tighter rate limit (5/hour/IP) than logged-in users (30/hour/user).
// Logged-in users always have their saved server-side preferences applied;
// anonymous users may pass preferences in the request body.
//
// We forward to claude-sonnet-4-6 via the Anthropic Messages API using a
// hand-rolled fetch wrapper (see src/lib/claude.ts). Output is validated
// with zod before being returned to the client — bad/non-JSON output
// from the model surfaces as a 502 rather than a confusing 200.

import { z } from "zod";
import { db } from "@/lib/db";
import { optionalUser } from "@/lib/auth-bearer";
import { analyzeFridge, ClaudeError } from "@/lib/claude";
import { consume, clientIp } from "@/lib/rate-limit";
import { LIMITS } from "@/lib/limits";

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

  const auth = await optionalUser(req);

  // Rate-limit BEFORE calling Claude — these calls cost real money.
  const rate = auth
    ? consume("analyze-user", auth.userId)
    : consume("analyze-anon", clientIp(req));
  if (!rate.ok) {
    return Response.json(
      {
        error: auth
          ? "Rate limit exceeded (30/hour). Try again later."
          : "Rate limit exceeded (5/hour). Sign in for a higher limit.",
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

  // Resolve preferences. Logged-in users: always use server-side row
  // (ignore body), so a stale iOS client can't override prefs the user
  // updated elsewhere. Anonymous: use body or default to empty.
  let preferences: Prefs = EMPTY_PREFS;
  if (auth) {
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
  } else if (parsed.data.preferences) {
    const p = parsed.data.preferences;
    preferences = {
      dietary: p.dietary ?? [],
      cuisines: p.cuisines ?? [],
      dislikes: p.dislikes ?? [],
      occasion: p.occasion ?? [],
      equipment: p.equipment ?? [],
      time: p.time ?? [],
      difficulty: p.difficulty ?? [],
      allergies: p.allergies ?? [],
    };
  }

  try {
    const result = await analyzeFridge({
      imageBase64: parsed.data.imageBase64,
      preferences,
    });
    return Response.json(result, {
      headers: {
        "X-RateLimit-Limit": String(rate.limit),
        "X-RateLimit-Remaining": String(rate.remaining),
      },
    });
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
