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
import { clusterLabel, pickBadgeSize } from './aggregateClusterUtils';
import type { MapCluster } from '../../types/media';

// ---------------------------------------------------------------------------
// Type augmentation — carry the per-cell weight (and sample id) on each marker
// so the cluster's iconCreateFunction and click handler can sum true counts.
// ---------------------------------------------------------------------------

declare module 'leaflet' {
  interface MarkerOptions {
    mhCount?: number;
    mhSampleId?: string;
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
 * Build a tiny bounding box around a single point. The "Photos here" drawer
 * refetches authoritative points for whatever bbox it receives, so a small
 * fixed epsilon is sufficient for a single aggregate cell.
 */
function bboxForCell(c: MapCluster): { bbox: string; lat: number; lng: number; total: number } {
  const eps = 0.001;
  return {
    bbox: `${c.lng - eps},${c.lat - eps},${c.lng + eps},${c.lat + eps}`,
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
        const total = cluster
          .getAllChildMarkers()
          .reduce((sum, m) => sum + ((m as L.Marker).options.mhCount ?? 1), 0);
        return badgeIcon(total);
      },
    });
    groupRef.current = group;
    map.addLayer(group);

    // Bind clusterclick once — uses the stable refs so it always has the latest
    // callback without re-binding (which would lose cluster animation state).
    group.on('clusterclick', (e: L.LeafletEvent) => {
      const cluster = (e as ClusterClickEvent).layer;
      const bounds = cluster.getBounds();
      const total = cluster
        .getAllChildMarkers()
        .reduce((sum, m) => sum + ((m as L.Marker).options.mhCount ?? 1), 0);
      // If the cluster can still split by zooming in, fly to its bounds;
      // otherwise open the "Photos here" drawer for the covered area.
      if (map.getBoundsZoom(bounds) > map.getZoom() && map.getZoom() < map.getMaxZoom()) {
        map.flyToBounds(bounds, { padding: [40, 40] });
      } else {
        const center = bounds.getCenter();
        onOpenClusterBboxRef.current({
          bbox: `${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`,
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
