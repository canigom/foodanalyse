// /api/recipes — GET (list user's saved recipes) + POST (save a new one).
//
// Each recipe is owned by exactly one user; the schema's onDelete: Cascade
// removes them with the user (DSGVO Art. 17).

import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth-bearer";
import { LIMITS } from "@/lib/limits";

export const runtime = "nodejs";

const RecipeBodySchema = z.object({
  name: z.string().min(1).max(LIMITS.recipeName),
  description: z.string().min(1).max(LIMITS.recipeDescription),
  ingredients: z.array(z.string().min(1).max(LIMITS.ingredientItem)).min(1).max(50),
  steps: z.array(z.string().min(1).max(LIMITS.stepItem)).min(1).max(30),
  cookingTimeMinutes: z.number().int().nonnegative().max(24 * 60),
  imageBase64: z.string().max(LIMITS.imageBase64).optional(),
});

export async function GET(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  const recipes = await db.savedRecipe.findMany({
    where: { userId: auth.userId },
    orderBy: { createdAt: "desc" },
  });
  return Response.json({ recipes });
}

export async function POST(req: Request) {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = RecipeBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const recipe = await db.savedRecipe.create({
    data: {
      userId: auth.userId,
      name: parsed.data.name,
      description: parsed.data.description,
      ingredients: parsed.data.ingredients,
      steps: parsed.data.steps,
      cookingTimeMinutes: parsed.data.cookingTimeMinutes,
      imageBase64: parsed.data.imageBase64 ?? null,
    },
  });
  return Response.json({ recipe }, { status: 201 });
}
