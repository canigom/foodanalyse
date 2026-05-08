// Shared input-length caps. Imported by every API route that accepts
// user input.
//
// Two reasons these exist:
//   1. DoS prevention — without caps a logged-in user can stuff megabytes
//      into JSON, fill Postgres, or burn CPU on bcrypt with a 10MB
//      password.
//   2. Data-shape sanity — keeps DB rows reasonable.

export const LIMITS = {
  email: 254,            // RFC 5321
  password: 128,         // bcrypt has a hard limit at ~72 bytes; cap inputs well below DoS territory
  passwordMin: 8,
  name: 100,
  // Recipe text fields
  recipeName: 200,
  recipeDescription: 2_000,
  ingredientItem: 200,
  stepItem: 1_000,
  // Up to ~20 prefs across all 3 lists
  preferenceItem: 100,
  // Base64-encoded JPEG thumbnails. ~1 MB raw → ~1.4 MB base64.
  imageBase64: 2_000_000,
} as const;

// Coerce arbitrary input to a trimmed string, hard-capped at `max` chars.
export function clean(value: unknown, max: number): string {
  return String(value ?? "").slice(0, max).trim();
}
