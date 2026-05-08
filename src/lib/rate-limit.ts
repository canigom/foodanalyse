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

const WINDOW_MS = 60 * 60 * 1000; // 1 hour rolling window

const LIMITS_PER_HOUR = {
  "analyze-anon": 5,
  "analyze-user": 30,
} as const;

export type RateKind = keyof typeof LIMITS_PER_HOUR;

export type RateResult = {
  ok: boolean;
  retryAfterSec: number;
  limit: number;
  remaining: number;
};

const buckets = new Map<string, Bucket>();

export function consume(kind: RateKind, principal: string): RateResult {
  const limit = LIMITS_PER_HOUR[kind];
  const key = `${kind}:${principal}`;
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  const bucket = buckets.get(key) ?? { hits: [] };
  // Drop expired hits so the array stays small.
  bucket.hits = bucket.hits.filter((t) => t > cutoff);

  if (bucket.hits.length >= limit) {
    const oldest = bucket.hits[0];
    return {
      ok: false,
      retryAfterSec: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)),
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
