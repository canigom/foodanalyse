// Household helpers — Phase 3 multi-household.
//
// `ensureActiveHousehold` is the central choke point: every read/write that
// is household-scoped (currently inventory; later shopping lists + meal
// plans) goes through here so we never have to repeat the lazy-create
// logic. It guarantees that on return:
//   1. The user has at least one Household row (their personal one).
//   2. They are a HouseholdMember of it (role 'owner' for the personal one).
//   3. user.activeHouseholdId is non-null and points at a household they
//      are still a member of.
//
// The first call after a fresh signup creates "Mein Haushalt" (or "My
// Household" if we ever localize server-side). Subsequent calls are a
// single SELECT + a possible re-pick if the user's previously-active
// household was deleted out from under them.

import { db } from "@/lib/db";

const PERSONAL_HOUSEHOLD_NAME = "Mein Haushalt";

// Returns the user's currently-active household id, creating their
// personal household + membership on the fly when nothing exists yet.
export async function ensureActiveHousehold(userId: string): Promise<string> {
  // Fast path: the user has an activeHouseholdId AND is still a member.
  const u = await db.user.findUnique({
    where: { id: userId },
    select: { activeHouseholdId: true },
  });
  if (!u) throw new Error("user not found");

  if (u.activeHouseholdId) {
    const member = await db.householdMember.findUnique({
      where: {
        householdId_userId: { householdId: u.activeHouseholdId, userId },
      },
      select: { id: true },
    });
    if (member) return u.activeHouseholdId;
    // Active household no longer exists / user no longer a member — fall
    // through and re-pick from the membership list.
  }

  // Pick the first household the user belongs to. If they own one, prefer
  // that (deterministic — owner row is the personal one for a fresh
  // signup); otherwise grab the oldest joined membership.
  const memberships = await db.householdMember.findMany({
    where: { userId },
    orderBy: [{ role: "asc" }, { joinedAt: "asc" }],
    select: { householdId: true, role: true },
  });

  if (memberships.length > 0) {
    const next = memberships[0].householdId;
    await db.user.update({
      where: { id: userId },
      data: { activeHouseholdId: next },
    });
    return next;
  }

  // No memberships at all → bootstrap a personal household. Wrap in a
  // transaction so the household + membership row + activeHouseholdId
  // pointer all land atomically.
  const created = await db.$transaction(async (tx) => {
    const hh = await tx.household.create({
      data: {
        name: PERSONAL_HOUSEHOLD_NAME,
        ownerId: userId,
      },
    });
    await tx.householdMember.create({
      data: { householdId: hh.id, userId, role: "owner" },
    });
    await tx.user.update({
      where: { id: userId },
      data: { activeHouseholdId: hh.id },
    });
    return hh.id;
  });

  return created;
}

// 8-char base32 (Crockford-ish — no I, L, O, U to dodge homoglyphs).
// Generates 5 bytes of entropy → 8 chars. ~10^12 codes; collisions on a
// `findUnique({ where: { inviteCode } })` are vanishingly rare even at
// 1M outstanding invites.
export function generateInviteCode(): string {
  const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  // Web-Crypto is available in the Next.js Edge + Node runtimes.
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 8; i++) {
    out += ALPHABET[buf[i] % ALPHABET.length];
  }
  return out;
}

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Helper for the route handlers — assert membership (any role) on a
// given household, returning 404 if absent so we don't leak existence.
export async function requireMembership(
  householdId: string,
  userId: string,
): Promise<{ role: string } | null> {
  const member = await db.householdMember.findUnique({
    where: { householdId_userId: { householdId, userId } },
    select: { role: true },
  });
  return member;
}
