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
};

function joinOr(items: string[], fallback: string): string {
  const cleaned = items.map((x) => x.trim()).filter(Boolean);
  if (cleaned.length === 0) return fallback;
  return cleaned.join(", ");
}

export function buildUserPrompt(prefs: AnalyzePreferences): string {
  return [
    "Schau dir das Foto vom Kühlschrank an. Liste die sichtbaren Zutaten auf. " +
      "Schlage dann genau 3 Rezepte vor, die diese Zutaten nutzen.",
    "",
    "Berücksichtige diese Präferenzen:",
    `- Ernährung: ${joinOr(prefs.dietary, "keine")}`,
    `- Bevorzugte Küchen: ${joinOr(prefs.cuisines, "alle")}`,
    `- Vermeide: ${joinOr(prefs.dislikes, "nichts")}`,
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
    '      "cookingTimeMinutes": number',
    "    }",
    "  ]",
    "}",
  ].join("\n");
}
