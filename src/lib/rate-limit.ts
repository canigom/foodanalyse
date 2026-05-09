// Simple in-memory rate limiter for the /api/analyze Claude proxy.
//
// Why in-memory and not Redis? KochHeute runs as a single Node process
// per VM. The bucket lives in module-scope state, gets reset on container
// restart, and cannot be shared across replicas — perfectly fine for
// single-VM deployment. Swap for Redis (e.g., Upstash) if scaling out.
//
// Anonymous callers are bucketed by IP (taken from X-Forwarded-For when
// behind nginx). Logged-in users get their own per-userId bucket with a
// higher cap, so a shared NAT can't lock a real user out.

type Bucket = { hits: number[] };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Each bucket has a window + a ceiling. Hourly buckets exist for API
// abuse protection (apply to all tiers including paying customers).
// Daily buckets are tier gates that kick in once the 24h trial expires
// — hitting them returns a 402 to the iOS client which renders the
// paywall.
const BUCKETS = {
  "analyze-anon": { windowMs: HOUR_MS, limit: 5 },
  "analyze-user": { windowMs: HOUR_MS, limit: 30 },
  // Free-tier daily caps. Numbers match FREE_TIER_LIMITS in lib/trial.ts —
  // keep them in sync if either side changes.
  "free-fridge": { windowMs: DAY_MS, limit: 1 },
  "free-meal": { windowMs: DAY_MS, limit: 3 },
} as const;

export type RateKind = keyof typeof BUCKETS;

export type RateResult = {
  ok: boolean;
  retryAfterSec: number;
  limit: number;
  remaining: number;
};

const buckets = new Map<string, Bucket>();

export function consume(kind: RateKind, principal: string): RateResult {
  const cfg = BUCKETS[kind];
  const { windowMs, limit } = cfg;
  const key = `${kind}:${principal}`;
  const now = Date.now();
  const cutoff = now - windowMs;

  const bucket = buckets.get(key) ?? { hits: [] };
  // Drop expired hits so the array stays small.
  bucket.hits = bucket.hits.filter((t) => t > cutoff);

  if (bucket.hits.length >= limit) {
    const oldest = bucket.hits[0];
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
      limit,
      remaining: 0,
    };
  }

  bucket.hits.push(now);
  buckets.set(key, bucket);
  return {
    ok: true,
    retryAfterSec: 0,
    limit,
    remaining: limit - bucket.hits.length,
  };
}

// Read-only check — does NOT increment the bucket. Used by /api/billing/status
// so the iOS client can render "X of Y remaining today" without burning a hit.
export function peek(kind: RateKind, principal: string): RateResult {
  const cfg = BUCKETS[kind];
  const { windowMs, limit } = cfg;
  const key = `${kind}:${principal}`;
  const now = Date.now();
  const cutoff = now - windowMs;
  const bucket = buckets.get(key) ?? { hits: [] };
  const live = bucket.hits.filter((t) => t > cutoff);
  const remaining = Math.max(0, limit - live.length);
  return {
    ok: live.length < limit,
    retryAfterSec: live.length >= limit ? Math.max(1, Math.ceil((live[0] + windowMs - now) / 1000)) : 0,
    limit,
    remaining,
  };
}

// Best-effort client IP. Behind nginx we trust the leftmost X-Forwarded-For
// entry (nginx appends the real client to the chain). Without a proxy,
// the request connection IP isn't directly available from the Web Request
// API in Node, so we fall back to a synthetic key — not great, but the
// public deployment always sits behind nginx so this branch only matters
// in local dev.
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}
