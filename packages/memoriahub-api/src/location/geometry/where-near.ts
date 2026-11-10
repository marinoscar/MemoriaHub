// =============================================================================
// whereNear: the bounding-box approximation of a geo radius filter
// =============================================================================
//
// The one implementation. The web app's media where-builder re-exports it, so the search filter
// `near` and the location-group rebuild agree on what "within N km" means.
// =============================================================================

/**
 * The lat/lng bounding box around a point, as a media-item `where` fragment.
 *
 * Intentional v1 approximation (a square around the circle): accurate enough for typical radii and
 * well within the margin of error for photo GPS coordinates.
 *
 * @param lat - the centre latitude.
 * @param lng - the centre longitude.
 * @param radiusKm - the radius in kilometres.
 * @stability experimental
 */
export function whereNear(
  lat: number,
  lng: number,
  radiusKm: number,
): { takenLat: { gte: number; lte: number }; takenLng: { gte: number; lte: number } } {
  const latDelta = radiusKm / 111.32;
  const cosLat = Math.cos((lat * Math.PI) / 180);
  // Guard against division-by-zero / extreme values near poles
  const lngDelta = cosLat > 0.0001 ? Math.min(radiusKm / (111.32 * cosLat), 180) : 180;

  return {
    takenLat: { gte: lat - latDelta, lte: lat + latDelta },
    takenLng: { gte: lng - lngDelta, lte: lng + lngDelta },
  };
}
