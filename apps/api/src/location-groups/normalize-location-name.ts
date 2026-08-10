// =============================================================================
// Location name normalization (issue #373, Location Grouping — Part 1)
// =============================================================================
//
// TWO deliberately different reductions live here, and conflating them is the
// bug this file exists to prevent:
//
//   fold()          — ALIAS IDENTITY. Deliberately conservative: accents, case,
//                     punctuation and whitespace only. It is what
//                     `LocationGroupAlias.normalizedValue` /
//                     `LocationGroup.normalizedName` store, and what the
//                     resolver matches on. Two genuinely different place names
//                     can NEVER silently collide under it.
//
//   suggestionKey() — SUGGESTION CLUSTERING. fold() plus level-aware
//                     administrative-noise stripping, so "Heredia",
//                     "Heredia Province" and "Provincia de Heredia" land in one
//                     bucket. Consumed ONLY by the group-suggestions endpoint
//                     (issue #374) — NEVER by resolution, because it is
//                     aggressive enough to conflate real, distinct places.
//
// =============================================================================

import type { LocationGroupLevel } from '@prisma/client';

/**
 * Alias identity: strip diacritics, lowercase, drop punctuation, collapse
 * whitespace.
 *
 *   "San José"  → "san jose"
 *   "SAN JOSE"  → "san jose"
 *   "St. Louis" → "st louis"
 *
 * Nothing semantic is removed — "San Jose" and "San Juan" stay distinct.
 */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // "San José" → "San Jose"
    .toLowerCase()
    .replace(/[.,'’`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Level-aware administrative noise, applied to an ALREADY-FOLDED string.
 *
 * Leading entries are matched as whole leading words (prefix + a space);
 * trailing entries are matched as whole trailing words. Both lists are applied
 * longest-first so "provincia de" wins over "provincia".
 *
 * Note the country row: it deliberately does NOT strip " province", so a
 * country-level key for a (hypothetical) place literally named "X Province"
 * keeps its suffix — administrative noise is only noise at the level it
 * belongs to.
 */
const NOISE: Record<LocationGroupLevel, { leading: string[]; trailing: string[] }> = {
  country: {
    leading: ['the'],
    trailing: [' (the)'],
  },
  region: {
    leading: [
      'provincia de',
      'provincia',
      'province of',
      'prov',
      'estado de',
      'state of',
      'departamento de',
      'department of',
      'region de',
      'region of',
    ],
    trailing: [
      ' province',
      ' provincia',
      ' region',
      ' state',
      ' department',
      ' prefecture',
      ' oblast',
    ],
  },
  locality: {
    leading: ['city of', 'ciudad de', 'municipio de', 'municipality of', 'town of'],
    trailing: [' city', ' municipality', ' municipio'],
  },
};

/** Longest-first ordering so a longer phrase is never shadowed by its prefix. */
const byLengthDesc = (a: string, b: string): number => b.length - a.length;

/**
 * Strip level-appropriate administrative noise from a folded string.
 *
 * One leading match and one trailing match per call — enough for every real
 * form ("Provincia de Heredia", "Heredia Province"), and bounded so a
 * pathological input can't be whittled down to nothing.
 *
 * Exported for the suggestions endpoint's tests; production callers should use
 * `suggestionKey`, which folds first.
 */
export function stripNoise(level: LocationGroupLevel, folded: string): string {
  const noise = NOISE[level];
  if (!noise) return folded;

  let out = folded;

  for (const prefix of [...noise.leading].sort(byLengthDesc)) {
    if (out.startsWith(`${prefix} `)) {
      out = out.slice(prefix.length + 1);
      break;
    }
  }

  for (const suffix of [...noise.trailing].sort(byLengthDesc)) {
    if (out.endsWith(suffix)) {
      out = out.slice(0, out.length - suffix.length);
      break;
    }
  }

  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Suggestion clustering key — `stripNoise(level, fold(s))`.
 *
 * ⚠️ NEVER use this for resolution. It is intentionally lossy enough that two
 * distinct administrative units can share a key; that is acceptable when
 * PROPOSING a group to an admin for review, and unacceptable when silently
 * rewriting a media item's canonical location.
 */
export function suggestionKey(level: LocationGroupLevel, s: string): string {
  return stripNoise(level, fold(s));
}
