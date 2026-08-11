/**
 * The destination model — canonical keys, route ownership, and active state.
 *
 * Spec §3.5. Collapsing 22 drawer rows into four destinations creates a problem
 * the old navigation did not have: **a destination must light up for routes
 * whose paths do not resemble it.** Standing at `/bursts` the active
 * destination is Review, but `/bursts` does not start with `/review`. A
 * `startsWith` on the item's own path — what `Sidebar` used to do — cannot
 * express that, so the mapping is declared here instead of inferred.
 *
 * Two rules make the table trustworthy:
 *
 *  1. **A route is owned by at most one destination.** A test asserts this
 *     against the live `App.tsx`, which is what keeps the table honest as
 *     routes are added — it fails loudly the day someone adds a route and
 *     forgets this file.
 *  2. **Matching respects segment boundaries.** A bare `startsWith` would make
 *     `/review` match `/reviewer` and `/bursts` match `/burstsfoo`. Note this
 *     is also why `/review-insights` and `/review-runs` are enumerated
 *     separately below rather than being covered by `/review`: under this rule
 *     they are NOT children of it.
 */

export type DestinationKey = 'photos' | 'collections' | 'search' | 'review' | 'console';

/**
 * Does `prefix` own `path`? True when the path equals the prefix or continues
 * with a `/`. `'/'` matches only itself — every path starts with it, so the
 * root has to be exact or it would own the entire app.
 */
export function owns(prefix: string, path: string): boolean {
  if (prefix === '/') return path === '/';
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Route prefixes each destination owns. Child routes are covered by their
 * parent prefix (`/albums/:albumId`, `/bursts/:id`, `/places/countries`, …) and
 * do not need their own entries.
 */
export const DESTINATION_ROUTES: Record<DestinationKey, readonly string[]> = {
  photos: ['/', '/media'],
  collections: [
    '/collections',
    '/albums',
    '/people',
    '/places',
    '/memories',
    '/map',
    '/archive',
    '/trash',
    '/tags',
  ],
  search: ['/search'],
  review: [
    '/review',
    '/bursts',
    '/duplicates',
    '/review-insights',
    '/location-suggestions',
    '/enhancements',
    '/workflows',
    '/review-runs',
    '/location-suggestion-runs',
  ],
  console: ['/admin'],
};

/**
 * Routes deliberately owned by NO destination.
 *
 * These are reached from the top bar (avatar menu, circle chip, bell) or from
 * outside the app entirely. **On these routes no destination renders as active,
 * and that is correct rather than a bug** — highlighting an unrelated
 * destination would be worse than highlighting none. Exported so a test can
 * assert it explicitly, which is what stops a future contributor from "fixing"
 * it into highlighting something arbitrary.
 */
export const UNOWNED_ROUTES: readonly string[] = [
  '/settings',
  '/profile',
  '/circles',
  '/notifications',
  '/activate',
  '/login',
  '/auth/callback',
  '/s/:token',
];

/**
 * Which destination, if any, owns `pathname`.
 *
 * Longest prefix wins where prefixes overlap. They do not overlap today, but
 * encoding the rule costs nothing and removes the question from every future
 * addition to the table.
 */
export function resolveActiveDestination(pathname: string): DestinationKey | null {
  let best: { key: DestinationKey; length: number } | null = null;

  for (const [key, prefixes] of Object.entries(DESTINATION_ROUTES) as [
    DestinationKey,
    readonly string[],
  ][]) {
    for (const prefix of prefixes) {
      if (!owns(prefix, pathname)) continue;
      if (!best || prefix.length > best.length) {
        best = { key, length: prefix.length };
      }
    }
  }

  return best?.key ?? null;
}
