// /api/households — GET (list memberships) + POST (create new household).
//
// GET lazily creates the user's personal household on first call so the
// iOS app never has to special-case an "I have zero households" state.
// Returns the full member list per household so the iOS detail screen
// can render avatars without a follow-up call.
//
// POST is premium-gated: free users always belong to exactly one personal
// household and can't spin up additional ones. We surface that as 402
// Payment Required so the existing `PaywallRequiredError` plumbing on the
// iOS side handles it for free.

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { LIMITS } from "@/lib/limits";
import { ensureActiveHousehold } from "@/lib/household";
import { isInTrial } from "@/lib/trial";

export const runtime = "nodejs";

const CreateSchema = z.object({
  name: z.string().min(1).max(LIMITS.recipeName),
});

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  // Lazy-create + active id pick. ensureActiveHousehold also handles the
  // "user's previous active household was deleted" edge so the value we
  // return below is guaranteed valid.
  const activeHouseholdId = await ensureActiveHousehold(auth.userId);

  // Pull every household the user is a member of, including each
  // household's full member roster + the joined User basics for the
  // iOS detail screen avatar list.
  const memberships = await db.householdMember.findMany({
    where: { userId: auth.userId },
    orderBy: { joinedAt: "asc" },
    select: {
      household: {
        select: {
          id: true,
          name: true,
          ownerId: true,
          createdAt: true,
          inviteCode: true,
          inviteExpiresAt: true,
          members: {
            orderBy: { joinedAt: "asc" },
            select: {
              id: true,
              userId: true,
              role: true,
              joinedAt: true,
              user: {
                select: { id: true, name: true, email: true },
              },
            },
          },
        },
      },
    },
  });

  const households = memberships.map((m) => m.household);

  return Response.json({ households, activeHouseholdId });
}

export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  // Premium gate. Today the only "premium" signal we trust is the 24h
  // signup trial; once IAP lands we'll OR in a real subscription check.
  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: { id: true, createdAt: true },
  });
  if (!user) {
    return Response.json({ error: "User no longer exists" }, { status: 401 });
  }
  if (!isInTrial(user)) {
    return Response.json(
      { error: "premium_only", message: "Mehrere Haushalte nur in Premium" },
      { status: 402 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Make sure the personal household exists first; otherwise a brand-new
  // user creating their second household before ever calling GET could
  // skip the lazy-create path.
  await ensureActiveHousehold(auth.userId);

  const household = await db.$transaction(async (tx) => {
    const hh = await tx.household.create({
      data: { name: parsed.data.name, ownerId: auth.userId },
    });
    await tx.householdMember.create({
      data: { householdId: hh.id, userId: auth.userId, role: "owner" },
    });
    return hh;
  });

  return Response.json({ household }, { status: 201 });
}
