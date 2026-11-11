/**
 * Alias identity: strip diacritics, lowercase, drop punctuation, collapse
 * whitespace.
 *
 *   "San José"  → "san jose"
 *   "SAN JOSE"  → "san jose"
 *   "St. Louis" → "st louis"
 *
 * Nothing semantic is removed — "San Jose" and "San Juan" stay distinct.
 *
 * @stability experimental
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

