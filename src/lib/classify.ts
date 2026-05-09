// Lightweight image classifier used by /api/analyze and /api/meals to
// detect when the user is in the wrong section before we burn a full
// Sonnet vision call.
//
// Uses Claude Haiku 4.5 (cheap + fast) with a 10-token cap and a strict
// one-word output prompt. Classifies into:
//   - "fridge" — Kühlschrank/Vorratsschrank/Zutaten on a counter
//   - "meal"   — fertig zubereitete Mahlzeit auf einem Teller
//   - "other"  — clearly neither (random object, person, scenery)
//   - null     — classifier failure (network down, missing key, etc.)
//
// Routes use the null vs "other" distinction: null means "we don't know,
// let it through to Sonnet", "other" means "Haiku is confident it's not
// what the user picked, reject early". Never block a legitimate user on
// a flaky classifier.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 10;

const CLASSIFY_SYSTEM_PROMPT =
  "Du klassifizierst Bilder für eine Koch-App. " +
  "Antworte ausschließlich mit einem Wort: fridge, meal, oder other.";

const CLASSIFY_USER_PROMPT =
  "Ist das Bild ein Kühlschrank/Vorratsschrank mit Zutaten ('fridge'), " +
  "eine fertig zubereitete Mahlzeit auf einem Teller ('meal'), " +
  "oder etwas anderes ('other')?";

export type ImageKind = "fridge" | "meal" | "other";

// --- Image preparation (same logic as src/lib/claude.ts, kept local so we
//     don't entangle the two modules). Strip a possible data URL prefix
//     and detect the media type from base64 magic bytes.

function detectMediaType(
  b64: string,
): "image/jpeg" | "image/png" | "image/webp" | "image/gif" {
  let head: Buffer;
  try {
    head = Buffer.from(b64.slice(0, 32), "base64");
  } catch {
    return "image/jpeg";
  }
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return "image/gif";
  if (
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
  ) return "image/webp";
  return "image/jpeg";
}

function prepareImage(imageBase64: string): {
  data: string;
  mediaType: ReturnType<typeof detectMediaType>;
} {
  let raw = imageBase64.trim();
  const comma = raw.indexOf(",");
  if (raw.startsWith("data:") && comma > 0) raw = raw.slice(comma + 1);
  return { data: raw, mediaType: detectMediaType(raw) };
}

// Parse the Haiku response text. We accept any of the three known values
// (case-insensitive, whitespace-trimmed). Anything else falls back to
// "other" so the caller doesn't block on classifier ambiguity.
function parseLabel(text: string): ImageKind {
  const t = text.trim().toLowerCase();
  if (t.startsWith("fridge")) return "fridge";
  if (t.startsWith("meal")) return "meal";
  if (t.startsWith("other")) return "other";
  return "other";
}

export async function classifyImage(base64: string): Promise<ImageKind | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("[classify] ANTHROPIC_API_KEY is not set; falling through");
    return null;
  }

  let prepared: { data: string; mediaType: ReturnType<typeof detectMediaType> };
  try {
    prepared = prepareImage(base64);
  } catch (err) {
    console.error("[classify] failed to prepare image:", err);
    return null;
  }

  const body = {
    model: HAIKU_MODEL,
    max_tokens: MAX_TOKENS,
    system: CLASSIFY_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: prepared.mediaType,
              data: prepared.data,
            },
          },
          { type: "text", text: CLASSIFY_USER_PROMPT },
        ],
      },
    ],
  };

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Network error — Haiku is down or unreachable. Don't block the user.
    console.error("[classify] network error:", err);
    return null;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(
      `[classify] Anthropic API error ${res.status}: ${text.slice(0, 300)}`,
    );
    return null;
  }

  let respJson: { content?: Array<{ type: string; text?: string }> };
  try {
    respJson = (await res.json()) as typeof respJson;
  } catch (err) {
    console.error("[classify] failed to parse Anthropic response:", err);
    return null;
  }

  const textBlock = respJson.content?.find(
    (b) => b.type === "text" && typeof b.text === "string",
  );
  if (!textBlock?.text) {
    console.error("[classify] no text content in Anthropic response");
    return null;
  }

  return parseLabel(textBlock.text);
}
