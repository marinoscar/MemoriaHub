// =============================================================================
// Memories — defensive parsing of the model's titling response (issue #306)
// =============================================================================
//
// Pure and total: `parseMemoryTitleResponse` NEVER throws. Every malformed
// shape a model can emit — prose around the JSON, a ```json fence, a trailing
// apology, a null subtitle, an object with the right keys and the wrong types,
// a 400-character "title" — resolves to either a clean result or `null`, and
// `null` means "use the template".
//
// That totality is the point. The caller's failure handling is one branch
// (`null` ⇒ template), so there is no path where a surprising response shape
// escapes as an exception and reaches the curator, whose contract is that
// titling can never fail a generation run.
// =============================================================================

import { z } from 'zod';
import { NARRATIVE_MAX_CHARS, SUBTITLE_MAX_CHARS, TITLE_MAX_CHARS } from './memory-title.prompts';

/** A validated, length-capped titling result. `title` is always non-empty. */
export interface ParsedMemoryTitle {
  title: string;
  subtitle: string | null;
  narrative: string | null;
}

/**
 * Subtitle/narrative accept `null` as well as a string because "I have nothing
 * to add here" is a legitimate answer, and a model asked for an empty string
 * will often send `null` instead. A missing or wrongly-typed TITLE, by
 * contrast, fails the whole parse — a memory with no title is not a partial
 * success, it is the template case.
 */
const responseSchema = z.object({
  title: z.string(),
  subtitle: z.string().nullish(),
  narrative: z.string().nullish(),
});

/**
 * Reduce raw model output to the JSON object inside it.
 *
 * Two independent repairs, in order:
 *  1. strip a ``` / ```json fence, which several models emit despite being
 *     told not to;
 *  2. slice from the first `{` to the last `}`, which removes a leading
 *     "Sure, here you go:" and a trailing sign-off in one step.
 *
 * Returns null when there is no brace pair at all.
 */
export function extractJsonObject(raw: string): string | null {
  let text = raw.trim();

  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fenced?.[1]) text = fenced[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * Collapse whitespace, then hard-cap length with an ellipsis so the result is
 * ALWAYS <= `maxChars` — the caps are a storage/UI contract, not a hint to the
 * model, so they are enforced here regardless of what came back.
 */
export function capText(value: string, maxChars: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, maxChars - 1).trimEnd()}…`;
}

/** Empty string and whitespace both normalize to `null` for optional fields. */
function optional(value: string | null | undefined, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const capped = capText(value, maxChars);
  return capped.length > 0 ? capped : null;
}

/**
 * Parse, validate and cap. Returns `null` for every failure mode: unparseable
 * text, valid JSON of the wrong shape, or a blank title.
 */
export function parseMemoryTitleResponse(raw: string): ParsedMemoryTitle | null {
  const json = extractJsonObject(raw);
  if (!json) return null;

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }

  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) return null;

  const title = capText(parsed.data.title, TITLE_MAX_CHARS);
  if (title.length === 0) return null;

  return {
    title,
    subtitle: optional(parsed.data.subtitle, SUBTITLE_MAX_CHARS),
    narrative: optional(parsed.data.narrative, NARRATIVE_MAX_CHARS),
  };
}
