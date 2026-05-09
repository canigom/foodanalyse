// Premium trial helpers.
//
// Every freshly-registered user gets 24 hours of full Premium access on the
// house — Sonnet quality, no rate limits beyond the global 30/h cap, no
// ads. After expiry we drop them to the free tier (1 fridge analysis/day,
// 3 meal logs/day, Haiku quality) until they pay.
//
// We derive trial state from User.createdAt instead of storing a separate
// `trialEndsAt` column: signups can't be back-dated, the calculation is
// trivially cheap, and there's nothing to migrate when we eventually add
// a real Subscription row for paying users.

export const TRIAL_HOURS = 24;
export const TRIAL_MS = TRIAL_HOURS * 60 * 60 * 1000;

export function isInTrial(user: { createdAt: Date }): boolean {
  return Date.now() - user.createdAt.getTime() < TRIAL_MS;
}

export function trialEndsAt(user: { createdAt: Date }): number {
  return user.createdAt.getTime() + TRIAL_MS;
}

export function trialMsRemaining(user: { createdAt: Date }): number {
  return Math.max(0, trialEndsAt(user) - Date.now());
}

// Free-tier daily caps applied AFTER the trial expires. Trial + premium
// users are subject only to the global per-hour rate limit (analyze-user)
// to keep the door from blowing off the hinges if someone scripts the
// endpoint. These numbers are tuned to nudge free users toward upgrading
// without being miserly enough to make the app feel broken.
export const FREE_TIER_LIMITS = {
  fridgeAnalysesPerDay: 1,
  mealLogsPerDay: 3,
  savedRecipesMax: 5,
} as const;

// Premium-tier limits — used for forward compat. No real subscription
// row exists yet, so this branch is currently unreachable. The numbers
// are intentionally absurd ("unlimited" surfaced as a sentinel) so the
// iOS UI can render "Unbegrenzt" for premium users without a special
// case. We keep the per-hour 30-call ceiling on the analyze-user bucket
// regardless — that's API abuse protection, not a tier feature.
export const PREMIUM_TIER_LIMITS = {
  fridgeAnalysesPerDay: 999,
  mealLogsPerDay: 999,
  savedRecipesMax: 999,
} as const;

export type Tier = "trial" | "free" | "premium";

export type TierLimits = {
  fridgeAnalysesPerDay: number;
  mealLogsPerDay: number;
  savedRecipesMax: number;
};

// Compute the user's tier + limits from their createdAt. Premium isn't
// derivable yet (no Subscription model) so we never return "premium"
// here; the type is included so callers can branch defensively when we
// add IAP wiring.
export function tierFor(user: { createdAt: Date }): {
  tier: Tier;
  limits: TierLimits;
  trialEndsAt: number | null;
  msRemaining: number;
} {
  if (isInTrial(user)) {
    return {
      tier: "trial",
      limits: PREMIUM_TIER_LIMITS,
      trialEndsAt: trialEndsAt(user),
      msRemaining: trialMsRemaining(user),
    };
  }
  return {
    tier: "free",
    limits: FREE_TIER_LIMITS,
    trialEndsAt: null,
    msRemaining: 0,
  };
}
