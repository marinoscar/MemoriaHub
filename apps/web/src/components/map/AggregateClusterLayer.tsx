/**
 * AggregateClusterLayer — imperative Leaflet wrapper (react-leaflet 5) that
 * feeds server-aggregated grid cells into leaflet.markercluster.
 *
 * The server returns pre-aggregated cells (each carrying a weighted `count`).
 * Drawing them 1:1 produces overlapping, unreadable blobs at low zoom; instead
 * we hand each cell to markercluster as a WEIGHTED marker so it de-collides by
 * pixel radius and re-clusters (with animation) on zoom. Cluster badges sum the
 * child weights rather than counting markers, so the displayed number matches
 * the true underlying item count.
 *
 * Must be rendered as a child of <MapContainer> so useMap() resolves. Manages
 * the markercluster layer imperatively; renders null to React.
 */

import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { defaultIcon } from '../../lib/leaflet-setup';
import {
  bboxFromExtent,
  clusterLabel,
  pickBadgeSize,
  sumWeights,
  unionExtents,
  type ClusterExtent,
} from './aggregateClusterUtils';
import type { MapCluster } from '../../types/media';

// ---------------------------------------------------------------------------
// Type augmentation — carry the per-cell weight, sample id and true member-point
// extent on each marker so the cluster's iconCreateFunction and click handler
// can sum true counts and union true footprints.
// ---------------------------------------------------------------------------

declare module 'leaflet' {
  interface MarkerOptions {
    mhCount?: number;
    mhSampleId?: string;
    mhExtent?: ClusterExtent;
  }
}

// leaflet.markercluster augments L.* but its clusterclick event type needs a
// small cast because the runtime event shape differs from the bundled types.
interface ClusterClickEvent extends L.LeafletEvent {
  layer: L.MarkerCluster;
}

interface AggregateClusterLayerProps {
  clusters: MapCluster[];
  themeMode: 'light' | 'dark';
  onOpenItem: (id: string) => void;
  onOpenClusterBbox: (a: { bbox: string; lat: number; lng: number; total: number }) => void;
}

// ---------------------------------------------------------------------------
// Opaque, theme-reactive count-badge divIcon. Color is driven by a container
// class (mh-theme-dark / mh-theme-light) toggled on the Leaflet container, so
// the badges recolor instantly when the app theme changes without rebuilding
// every icon.
// ---------------------------------------------------------------------------

(function injectBadgeIconStyles() {
  if (typeof document === 'undefined') return; // SSR guard
  const id = 'mh-badge-icon-styles';
  if (document.getElementById(id)) return; // only inject once
  const style = document.createElement('style');
  style.id = id;
  style.textContent = [
    '.mh-badge-icon { background: transparent !important; border: none !important; }',
    '.mh-badge-icon > div {',
    '  width: 100%; height: 100%; border-radius: 50%;',
    '  display: flex; align-items: center; justify-content: center;',
    '  font: 600 12px/1 system-ui, sans-serif; white-space: nowrap;',
    '}',
    '.leaflet-container.mh-theme-dark .mh-badge-icon > div {',
    '  background: #1e88e5; color: #fff; border: 2px solid #fff;',
    '  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);',
    '}',
    '.leaflet-container.mh-theme-light .mh-badge-icon > div {',
    '  background: #1565c0; color: #fff; border: 2px solid rgba(255, 255, 255, 0.9);',
    '  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);',
    '}',
  ].join('\n');
  document.head.appendChild(style);
})();

function badgeIcon(count: number): L.DivIcon {
  const s = pickBadgeSize(count);
  return L.divIcon({
    className: 'mh-badge-icon',
    html: `<div>${clusterLabel(count)}</div>`,
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
  });
}

/**
 * Extract the true member-point extent of an aggregate cell, or `null` when the
 * server did not supply one (older API build). Defensive only.
 */
function extentOf(c: MapCluster): ClusterExtent | null {
  const { minLat, minLng, maxLat, maxLng } = c;
  if (
    !Number.isFinite(minLat) ||
    !Number.isFinite(minLng) ||
    !Number.isFinite(maxLat) ||
    !Number.isFinite(maxLng)
  ) {
    return null;
  }
  return { minLat, minLng, maxLat, maxLng };
}

/**
 * Build the "Photos here" payload for a single aggregate cell.
 *
 * The bbox comes from the cell's REAL member-point extent, not from a fixed
 * epsilon around its centroid. A grid cell spans `90 / 2^zoom` degrees (~620 km
 * at zoom 4) while `lat`/`lng` is only the centroid of its photos, so a small
 * epsilon around that centroid is a pinhole that can miss every photo in the
 * cell when they are spread across several towns — the cause of the empty
 * "Photos here (0)" drawer.
 */
function bboxForCell(c: MapCluster): { bbox: string; lat: number; lng: number; total: number } {
  const extent = extentOf(c);
  // Defensive fallback for a payload without an extent: a tight box around the
  // centroid, which is at least correct for a single-point cell.
  const eps = 0.001;
  return {
    bbox: extent
      ? bboxFromExtent(extent)
      : `${c.lng - eps},${c.lat - eps},${c.lng + eps},${c.lat + eps}`,
    lat: c.lat,
    lng: c.lng,
    total: c.count,
  };
}

export function AggregateClusterLayer({
  clusters,
  themeMode,
  onOpenItem,
  onOpenClusterBbox,
}: AggregateClusterLayerProps) {
  const map = useMap();

  // The cluster group is created once and never recreated — only its layers change.
  const groupRef = useRef<L.MarkerClusterGroup | null>(null);

  // Stable refs so the clusterclick handler bound on mount always calls the
  // latest callbacks without needing to be re-bound.
  const onOpenItemRef = useRef(onOpenItem);
  const onOpenClusterBboxRef = useRef(onOpenClusterBbox);
  useEffect(() => {
    onOpenItemRef.current = onOpenItem;
  }, [onOpenItem]);
  useEffect(() => {
    onOpenClusterBboxRef.current = onOpenClusterBbox;
  }, [onOpenClusterBbox]);

  // ----- Mount / unmount: create and destroy the cluster group -----
  useEffect(() => {
    const group = L.markerClusterGroup({
      chunkedLoading: true,
      maxClusterRadius: 70,
      spiderfyOnMaxZoom: false,
      showCoverageOnHover: false,
      zoomToBoundsOnClick: false,
      removeOutsideVisibleBounds: true,
      // Sum the WEIGHTED counts of the child markers, not their count, so the
      // badge reflects the true underlying item total.
      iconCreateFunction: (cluster) => {
        const total = sumWeights(
          cluster.getAllChildMarkers().map((m) => (m as L.Marker).options.mhCount ?? 1),
        );
        return badgeIcon(total);
      },
    });
    groupRef.current = group;
    map.addLayer(group);

    // Bind clusterclick once — uses the stable refs so it always has the latest
    // callback without re-binding (which would lose cluster animation state).
    group.on('clusterclick', (e: L.LeafletEvent) => {
      const cluster = (e as ClusterClickEvent).layer;
      // `getBounds()` is the hull of the child MARKER positions — i.e. of the
      // cells' CENTROIDS. It is the right input for the zoom/fly decision below
      // (that is a screen-space question about marker placement), but the wrong
      // input for the drawer's refetch bbox: member photos can sit up to half a
      // cell outside it, which silently undercounts.
      const bounds = cluster.getBounds();
      // `getAllChildMarkers()` recurses into nested sub-clusters, so both the
      // weighted total and the extent union below cover every leaf cell.
      const children = cluster.getAllChildMarkers() as L.Marker[];
      const total = sumWeights(children.map((m) => m.options.mhCount ?? 1));
      // If the cluster can still split by zooming in, fly to its bounds;
      // otherwise open the "Photos here" drawer for the covered area.
      if (map.getBoundsZoom(bounds) > map.getZoom() && map.getZoom() < map.getMaxZoom()) {
        map.flyToBounds(bounds, { padding: [40, 40] });
      } else {
        const center = bounds.getCenter();
        const extents = children
          .map((m) => m.options.mhExtent)
          .filter((x): x is ClusterExtent => x !== undefined);
        const union = unionExtents(extents);
        onOpenClusterBboxRef.current({
          // Fall back to the marker-hull bbox only if no child carried an
          // extent (older API payload). Defensive only.
          bbox: union
            ? bboxFromExtent(union)
            : `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`,
          lat: center.lat,
          lng: center.lng,
          total,
        });
      }
    });

    return () => {
      map.removeLayer(group);
      groupRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  // ----- Theme: toggle the container class so badge colors track the app theme -----
  useEffect(() => {
    const el = map.getContainer();
    el.classList.toggle('mh-theme-dark', themeMode === 'dark');
    el.classList.toggle('mh-theme-light', themeMode === 'light');
  }, [map, themeMode]);

  // ----- Update markers whenever clusters change -----
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    group.clearLayers();

    const markers: L.Marker[] = [];
    for (const c of clusters) {
      const icon = c.count === 1 ? defaultIcon : badgeIcon(c.count);
      const marker = L.marker([c.lat, c.lng], {
        icon,
        mhCount: c.count,
        mhSampleId: c.sampleId,
        // Carried so a MERGED cluster can union the true footprints of its
        // child cells rather than reasoning from centroids alone.
        mhExtent: extentOf(c) ?? undefined,
      });

      marker.on('click', () => {
        if (c.count === 1) {
          onOpenItemRef.current(c.sampleId);
        } else {
          onOpenClusterBboxRef.current(bboxForCell(c));
        }
      });

      markers.push(marker);
    }
    group.addLayers(markers);
  }, [clusters]);

  // This component manages Leaflet imperatively — nothing to render.
  return null;
}
