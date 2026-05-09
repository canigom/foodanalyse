// Prompts for the Claude vision call powering /api/analyze.
//
// Both the system and user prompts are German because the iOS app's
// audience is German-speaking. The user prompt is parameterized with
// the caller's saved (or anonymously provided) preferences.

export const SYSTEM_PROMPT =
  "Du bist KochHeute, ein freundlicher Koch-Assistent. " +
  "Du analysierst Fotos von Kühlschränken und schlägst realistische Rezepte vor, " +
  "die hauptsächlich die sichtbaren Zutaten verwenden. " +
  "Antworte ausschließlich mit gültigem JSON, ohne Markdown-Codeblöcke und " +
  "ohne erklärenden Text davor oder danach.";

export type AnalyzePreferences = {
  dietary: string[];
  cuisines: string[];
  dislikes: string[];
  // All optional — older callers / older DB rows may not have these.
  occasion?: string[];
  equipment?: string[];
  time?: string[];
  difficulty?: string[];
  allergies?: string[];
};

function clean(items: string[] | undefined): string[] {
  if (!Array.isArray(items)) return [];
  return items.map((x) => String(x).trim()).filter(Boolean);
}

// Render a single "Bevorzuge X." style line, but only if the field is set.
// Returning null lets the caller skip empty categories without bloating
// the prompt with "keine / alle / nichts" placeholders for every category.
function line(label: string, items: string[] | undefined): string | null {
  const cleaned = clean(items);
  if (cleaned.length === 0) return null;
  return `- ${label}: ${cleaned.join(", ")}`;
}

export function buildUserPrompt(prefs: AnalyzePreferences): string {
  const prefLines: string[] = [];

  // Dietary always emitted (with "keine" fallback) — it's the most important
  // constraint and the model should explicitly acknowledge it.
  prefLines.push(`- Ernährung: ${clean(prefs.dietary).join(", ") || "keine"}`);

  const optional = [
    line("Bevorzugte Küchen", prefs.cuisines),
    line("Anlass / Mahlzeit", prefs.occasion),
    line("Verfügbares Equipment", prefs.equipment),
    line("Maximale Zubereitungszeit", prefs.time),
    line("Schwierigkeit", prefs.difficulty),
    line("Allergien (unbedingt vermeiden)", prefs.allergies),
    line("Sonstige Vermeidungen", prefs.dislikes),
  ].filter((x): x is string => x !== null);

  prefLines.push(...optional);

  return [
    "Schau dir das Foto vom Kühlschrank an. Liste die sichtbaren Zutaten auf. " +
      "Schlage dann genau 3 Rezepte vor, die diese Zutaten nutzen.",
    "",
    "Berücksichtige diese Präferenzen:",
    ...prefLines,
    "",
    "Schätze für jedes Rezept die Nährwerte pro Portion (realistisch und " +
      "konservativ). Gib calories als ganze Zahl in kcal an, protein/carbs/fat/fiber " +
      "in Gramm (Dezimalzahlen erlaubt). fiber ist optional.",
    "",
    "Antwortformat (gültiges JSON):",
    "{",
    '  "ingredients": ["string", ...],',
    '  "recipes": [',
    "    {",
    '      "name": "string",',
    '      "description": "string (1-2 Sätze)",',
    '      "ingredients": ["string", ...],',
    '      "steps": ["string", ...],',
    '      "cookingTimeMinutes": number,',
    '      "calories": number,',
    '      "protein": number,',
    '      "carbs": number,',
    '      "fat": number,',
    '      "fiber": number',
    "    }",
    "  ]",
    "}",
  ].join("\n");
}

// ---- Meal photo analysis ----
//
// Used by /api/meals POST. The user snaps a photo of a finished plate of food
// and Claude estimates the dish, portion, and per-portion nutrition.

export const MEAL_ANALYSIS_SYSTEM_PROMPT =
  "Du analysierst Fotos von fertig zubereiteten Mahlzeiten. " +
  "Identifiziere das Gericht, schätze die Portionsgröße, und schätze realistische Nährwerte. " +
  "Antworte ausschließlich mit gültigem JSON, ohne Markdown-Codeblöcke und " +
  "ohne erklärenden Text davor oder danach.";

export const MEAL_ANALYSIS_USER_PROMPT = [
  "Analysiere dieses Foto einer Mahlzeit. Gib zurück:",
  "{",
  '  "dishName": "string (auf Deutsch, kurz)",',
  '  "portionSize": "string (z.B. \'1 Teller\', \'ca. 350g\')",',
  '  "calories": number (kcal),',
  '  "protein": number (g),',
  '  "carbs": number (g),',
  '  "fat": number (g),',
  '  "fiber": number (g, optional),',
  '  "ingredients": ["string", ...] (sichtbare Hauptzutaten)',
  "}",
  "Sei realistisch und präzise. Bei Unsicherheit lieber eine Spannweite mitteln.",
].join("\n");
