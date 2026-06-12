import type L from 'leaflet';

/**
 * Collect the media ids from all child markers of a cluster.
 *
 * @param cluster - The Leaflet MarkerCluster that was clicked.
 * @param idOf    - A function that maps a Marker to its media id (or undefined
 *                  if the marker is not tracked in the id map).
 * @returns An array of media ids for every tracked child marker.
 */
export function collectClusterIds(
  cluster: L.MarkerCluster,
  idOf: (m: L.Marker) => string | undefined,
): string[] {
  return cluster
    .getAllChildMarkers()
    .map((m) => idOf(m as L.Marker))
    .filter((id): id is string => id !== undefined);
}
