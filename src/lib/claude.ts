// Server-side Anthropic Messages API wrapper used by /api/analyze.
//
// We hit the REST endpoint directly with `fetch` instead of pulling in the
// official SDK. The SDK is great but only the Messages endpoint is needed
// here, and a hand-rolled wrapper keeps the dependency tree slim. Image
// inputs go in as base64 image blocks.
//
// The model ID is pinned to claude-sonnet-4-6 per the project spec — Sonnet
// is the right tradeoff for vision + structured output.

import { z } from "zod";
import { SYSTEM_PROMPT, buildUserPrompt, type AnalyzePreferences } from "@/lib/prompts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 4096;

const RecipeSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  ingredients: z.array(z.string().min(1)),
  steps: z.array(z.string().min(1)),
  cookingTimeMinutes: z.number().int().nonnegative(),
});

const AnalyzeResponseSchema = z.object({
  ingredients: z.array(z.string().min(1)),
  recipes: z.array(RecipeSchema),
});

export type Recipe = z.infer<typeof RecipeSchema>;
export type AnalyzeResult = z.infer<typeof AnalyzeResponseSchema>;

export class ClaudeError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function detectMediaType(b64: string): "image/jpeg" | "image/png" | "image/webp" | "image/gif" {
  // Decode just enough of the base64 to look at the magic bytes. Buffer.from
  // is happy to truncate, so a 12-byte slice off the front is plenty.
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
  // Default — Claude is forgiving when the bytes really are JPEG.
  return "image/jpeg";
}

// Strip a possible ```json ... ``` fence and a leading "Here's the JSON:"
// preamble. Claude is told NOT to wrap, but cheap defense costs nothing.
function unwrapJson(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    // ```json\n...\n```
    const firstNewline = t.indexOf("\n");
    if (firstNewline >= 0) t = t.slice(firstNewline + 1);
    if (t.endsWith("```")) t = t.slice(0, -3);
    t = t.trim();
  }
  // Sometimes models emit prose then JSON; grab the first {...} block.
  if (!t.startsWith("{")) {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) t = t.slice(start, end + 1);
  }
  return t;
}

export async function analyzeFridge(args: {
  imageBase64: string;
  preferences: AnalyzePreferences;
}): Promise<AnalyzeResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new ClaudeError("ANTHROPIC_API_KEY is not set", 500);
  }

  // The iOS app may send a data URI ("data:image/jpeg;base64,...") or a
  // bare base64 payload. Strip the prefix if present.
  let raw = args.imageBase64.trim();
  const comma = raw.indexOf(",");
  if (raw.startsWith("data:") && comma > 0) raw = raw.slice(comma + 1);

  const mediaType = detectMediaType(raw);

  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: raw },
          },
          { type: "text", text: buildUserPrompt(args.preferences) },
        ],
      },
    ],
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Surface Anthropic's status (e.g., 429 rate limit, 400 bad image)
    // back to the iOS app so it can show the right error.
    throw new ClaudeError(
      `Anthropic API error ${res.status}: ${text.slice(0, 500)}`,
      res.status,
    );
  }

  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const textBlock = data.content?.find((b) => b.type === "text" && typeof b.text === "string");
  if (!textBlock?.text) throw new ClaudeError("Claude returned no text content", 502);

  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapJson(textBlock.text));
  } catch {
    throw new ClaudeError("Claude returned non-JSON output", 502);
  }

  const result = AnalyzeResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new ClaudeError(
      `Claude output failed validation: ${result.error.message}`,
      502,
    );
  }
  return result.data;
}
