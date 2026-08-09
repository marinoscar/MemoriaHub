// =============================================================================
// Great-circle distance — the ONE implementation (epic #300, issue #304)
// =============================================================================
//
// Extracted from LocationInferenceService, which owned the only copy until the
// Memories Trips curator (#304) needed the same computation for "how far is
// this day from home?". Issue #304 explicitly calls for moving it to a shared
// util rather than growing a second copy: two haversines that drift apart by an
// earth-radius constant would make a location suggestion and a trip boundary
// disagree about the same pair of coordinates, which is exactly the class of bug
// nobody goes looking for.
//
// `location-inference.service.ts` re-exports `haversineKm` from here, so its
// existing importers (and its golden-value spec) are unaffected.
// =============================================================================

/** Mean Earth radius, kilometers — the spherical approximation's one constant. */
export const EARTH_RADIUS_KM = 6371;

/**
 * Great-circle distance between two lat/lng points, in kilometers.
 *
 * Spherical (haversine), not ellipsoidal: the ~0.5% worst-case error against
 * WGS-84 is far below the resolution any caller here cares about — a 50 km trip
 * threshold and a multi-kilometer anchor-agreement radius.
 */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}
