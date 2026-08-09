// =============================================================================
// Memories — the AI titling prompt, in one file (epic #300, issue #306)
// =============================================================================
//
// Pure, zero-I/O, zero-Nest: the system prompt constant plus the per-type
// context builder that turns already-computed facts into the user message.
//
// WHY THE PROMPT IS ISOLATED HERE. A prompt is the least reviewable thing in a
// codebase — it has no type errors and no test failures of its own, so drift is
// invisible in a diff unless the output is asserted somewhere. Every builder
// output is snapshotted per memory type in memory-title.prompts.spec.ts, which
// makes a wording change show up as a reviewable diff instead of a silent
// behavioral change in production.
//
// WHAT MAY LEAVE THE DEPLOYMENT. Metadata only — never image bytes (rejected in
// #306 for cost/latency at library scale; the tags and descriptions below are
// themselves already AI-derived from pixels, so the visual signal arrives
// secondhand and free). And within metadata, only what the issue enumerates:
// memory type, date range, place names, person names, top AI tags with counts,
// up to five truncated AI descriptions, item count, years-ago.
//
// Absent BY CONSTRUCTION, because this builder takes facts rather than rows:
// no ids of any kind (media item, circle, person, user), no file names, no
// storage keys, no GPS coordinates, no EXIF. `MemoryTitleFacts` is the complete
// list of what can be sent, and memory-title.prompts.spec.ts asserts that a
// rendered prompt contains no UUID.
// =============================================================================

import { MemoryType } from '@prisma/client';

// --- Output caps (mirrored in the system prompt AND enforced on parse) -------

/** Hard cap on the generated title. */
export const TITLE_MAX_CHARS = 60;
/** Hard cap on the generated subtitle. */
export const SUBTITLE_MAX_CHARS = 80;
/** Hard cap on the generated narrative blurb. */
export const NARRATIVE_MAX_CHARS = 240;

// --- Input caps --------------------------------------------------------------

/** Most AI tags described to the model, highest count first. */
export const MAX_PROMPT_TAGS = 10;
/** Most item descriptions included. */
export const MAX_PROMPT_DESCRIPTIONS = 5;
/** Each description is truncated to this many characters. */
export const DESCRIPTION_MAX_CHARS = 200;
/** Most person names included. */
export const MAX_PROMPT_PERSON_NAMES = 5;

/**
 * The system prompt. One exported constant, per #306 — the tone rules are a
 * product decision, not an implementation detail, and they belong somewhere a
 * reviewer can find without reading the service.
 */
export const MEMORY_TITLE_SYSTEM_PROMPT = [
  'You write titles for a private family photo app. A "memory" is a small,',
  'automatically curated collection of a family\'s own photos and videos.',
  '',
  'Voice: warm, specific and human — the way someone would describe the',
  'collection to their own family. Never saccharine, never advertising copy,',
  'never a listicle. No emojis. No exclamation marks unless genuinely earned,',
  'and never more than one. Do not invent people, places or events that the',
  'supplied facts do not mention; if the facts are thin, stay general rather',
  'than fabricating detail. Do not address the reader or refer to yourself.',
  '',
  'You are given facts about one memory, including the deterministic fallback',
  'title the app would otherwise use. Improve on it when the facts support',
  'something better; stay close to it when they do not.',
  '',
  'Respond with ONLY a JSON object, no code fences and no commentary:',
  '{"title": string, "subtitle": string, "narrative": string}',
  `- "title": at most ${TITLE_MAX_CHARS} characters.`,
  `- "subtitle": at most ${SUBTITLE_MAX_CHARS} characters; a short line of`,
  '  context such as the place or the date range. May be an empty string.',
  `- "narrative": at most ${NARRATIVE_MAX_CHARS} characters; one or two`,
  '  sentences describing what this collection holds. May be an empty string.',
].join('\n');

/** Human-readable label per memory type, used to open the fact block. */
const TYPE_LABELS: Record<MemoryType, string> = {
  on_this_day: 'On this day (an anniversary of a past day)',
  trip: 'A trip away from home',
  person_highlights: 'Highlights of one person',
  person_over_years: 'One person across many years',
  theme: 'A theme drawn from photo tags',
  seasonal: 'One season',
  year_in_review: 'A whole year in review',
};

/**
 * The complete set of facts that may be described to the model.
 *
 * Every field is optional-by-emptiness rather than optional-by-absence, so the
 * renderer never has to distinguish "not applicable to this type" from "we have
 * no value" — both simply omit the line.
 */
export interface MemoryTitleFacts {
  type: MemoryType;
  itemCount: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  templateTitle: string;
  templateSubtitle: string | null;
  /** Trips: the dominant place, already narrowed by the curator. */
  place: { locality?: string | null; admin1?: string | null; country?: string | null } | null;
  /** Named people recognized in the selected items. */
  personNames: string[];
  /** Top AI-applied tags with per-memory item counts, highest first. */
  topTags: Array<{ name: string; count: number }>;
  /** AI-written descriptions of individual items. */
  descriptions: string[];
  /** `on_this_day` only: how far back the source photos are. */
  yearsAgo: number | null;
  /** `theme` only: the tag the memory is built from. */
  themeTag: string | null;
  /** `seasonal` only: 'winter' | 'spring' | 'summer' | 'fall'. */
  season: string | null;
  /** `seasonal` / `year_in_review` / `person_highlights`: the calendar year. */
  year: number | null;
}

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** Collapse whitespace and hard-truncate — model input, not prose. */
function condense(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1).trimEnd()}…`;
}

/**
 * Render the user message for one memory.
 *
 * Deterministic: identical facts render an identical string, byte for byte.
 * That is what makes the per-type snapshots in the spec meaningful, and it is
 * also what would let a future response cache key on this string.
 *
 * The input caps (`MAX_PROMPT_TAGS`, `MAX_PROMPT_DESCRIPTIONS`,
 * `DESCRIPTION_MAX_CHARS`, `MAX_PROMPT_PERSON_NAMES`) are applied HERE rather
 * than by the caller, so no call site can widen what gets sent.
 */
export function buildMemoryTitleUserPrompt(facts: MemoryTitleFacts): string {
  const lines: string[] = [];

  lines.push(`Memory type: ${TYPE_LABELS[facts.type]}`);
  lines.push(`Items in the collection: ${facts.itemCount}`);

  if (facts.periodStart && facts.periodEnd) {
    const start = isoDay(facts.periodStart);
    const end = isoDay(facts.periodEnd);
    lines.push(start === end ? `Date: ${start}` : `Date range: ${start} to ${end}`);
  }

  if (facts.yearsAgo !== null) {
    lines.push(`Years ago: ${facts.yearsAgo}`);
  }
  if (facts.year !== null) {
    lines.push(`Year: ${facts.year}`);
  }
  if (facts.season) {
    lines.push(`Season: ${facts.season}`);
  }
  if (facts.themeTag) {
    lines.push(`Theme tag: ${facts.themeTag}`);
  }

  if (facts.place) {
    const parts = [facts.place.locality, facts.place.admin1, facts.place.country]
      .map((p) => p?.trim())
      .filter((p): p is string => !!p);
    if (parts.length > 0) lines.push(`Place: ${parts.join(', ')}`);
  }

  const people = facts.personNames
    .map((n) => n.trim())
    .filter((n) => n.length > 0)
    .slice(0, MAX_PROMPT_PERSON_NAMES);
  if (people.length > 0) {
    lines.push(`People pictured: ${people.join(', ')}`);
  }

  const tags = facts.topTags
    .filter((t) => t.name.trim().length > 0)
    .slice(0, MAX_PROMPT_TAGS)
    .map((t) => `${t.name.trim()} (${t.count})`);
  if (tags.length > 0) {
    lines.push(`Common tags: ${tags.join(', ')}`);
  }

  const descriptions = facts.descriptions
    .map((d) => condense(d, DESCRIPTION_MAX_CHARS))
    .filter((d) => d.length > 0)
    .slice(0, MAX_PROMPT_DESCRIPTIONS);
  if (descriptions.length > 0) {
    lines.push('Sample photo descriptions:');
    for (const d of descriptions) lines.push(`- ${d}`);
  }

  lines.push(`Fallback title: ${facts.templateTitle}`);
  if (facts.templateSubtitle) {
    lines.push(`Fallback subtitle: ${facts.templateSubtitle}`);
  }

  return lines.join('\n');
}
