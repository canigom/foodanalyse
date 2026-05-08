// DELETE /api/recipes/:id
//
// Tenant check: deleteMany scoped to (id, userId) so a user can never
// delete someone else's recipe even if they guess the cuid. We return
// 404 (not 403) when the row doesn't match — saying "forbidden" would
// confirm the id exists, leaking it.
//
// Note: in Next.js 16 the params object is a Promise, hence the await.

import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";

export const runtime = "nodejs";

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const { id } = await ctx.params;

  const result = await db.savedRecipe.deleteMany({
    where: { id, userId: auth.userId },
  });

  if (result.count === 0) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
