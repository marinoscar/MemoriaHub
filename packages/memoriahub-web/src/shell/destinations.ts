/**
 * The route prefixes the domain pages of this package own, per destination key,
 * as data. The app's `DESTINATION_ROUTES` spreads them next to the prefixes of the
 * pages that have not moved yet (a prefix is owned by at most one destination, and
 * the app's route-ownership test asserts it against `App.tsx`).
 *
 * @stability experimental
 */
export const memoriahubDestinationRoutes: Readonly<{ photos: readonly string[]; collections: readonly string[] }> = {
  photos: ['/', '/media'],
  collections: ['/albums', '/places', '/map', '/archive', '/trash'],
};
