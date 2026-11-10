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

import { resolveActiveDestination as resolveShellDestination } from '@marinoscar/platform-web/shell/headless';
// RETRO-J11 (#626): the prefixes the packaged pages own, as data.
import { memoriahubDestinationRoutes } from '@marinoscar/memoriahub-web/shell';

export type DestinationKey = 'photos' | 'collections' | 'search' | 'review' | 'console';

/**
 * Does `prefix` own `path`? The packaged shell's rule (segment boundaries,
 * `'/'` owns only itself), re-exported so the app and the shell can never
 * disagree about route ownership (RETRO-F1, #571).
 */
export { owns } from '@marinoscar/platform-web/shell/headless';

/**
 * Route prefixes each destination owns. Child routes are covered by their
 * parent prefix (`/albums/:albumId`, `/bursts/:id`, `/places/countries`, …) and
 * do not need their own entries.
 */
export const DESTINATION_ROUTES: Record<DestinationKey, readonly string[]> = {
  photos: [...memoriahubDestinationRoutes.photos],
  collections: [
    '/collections',
    '/people',
    '/memories',
    '/tags',
    '/shared',
    // '/albums', '/places', '/map', '/archive' and '/trash' are the packaged media pages'.
    ...memoriahubDestinationRoutes.collections,
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
 * Longest prefix wins where prefixes overlap. The rule is the packaged shell's
 * (`resolveActiveDestination` of `@marinoscar/platform-web/shell/headless`),
 * applied to this app's table, so the rail, the bottom bar and the context
 * panes resolve the same destination.
 */
export function resolveActiveDestination(pathname: string): DestinationKey | null {
  return resolveShellDestination(DESTINATION_ROUTES, pathname);
}
