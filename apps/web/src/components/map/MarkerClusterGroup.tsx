/**
 * MarkerClusterGroup — imperative Leaflet wrapper for react-leaflet 5.
 *
 * Must be rendered as a child of <MapContainer> so that useMap() resolves.
 * Manages the leaflet.markercluster layer imperatively; renders null to React.
 */

import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { defaultIcon } from '../../lib/leaflet-setup';
import { collectClusterIds } from './clusterUtils';
import type { MediaLocation } from '../../types/media';

// ---------------------------------------------------------------------------
// Types — leaflet.markercluster augments L.* but its clusterclick event type
// needs a small cast because @types/leaflet.markercluster uses a slightly
// different event shape than what's emitted at runtime.
// ---------------------------------------------------------------------------

interface ClusterClickEvent extends L.LeafletEvent {
  layer: L.MarkerCluster;
}

interface MarkerClusterGroupProps {
  points: MediaLocation[];
  onClusterClick: (ids: string[]) => void;
  onMarkerClick: (id: string) => void;
}

export function MarkerClusterGroup({
  points,
  onClusterClick,
  onMarkerClick,
}: MarkerClusterGroupProps) {
  const map = useMap();

  // The cluster group is created once and never recreated — only its layers change.
  const groupRef = useRef<L.MarkerClusterGroup | null>(null);

  // WeakMap lets us look up the media id for any given Marker without
  // attaching non-standard properties to the Leaflet object.
  const idMapRef = useRef<WeakMap<L.Marker, string>>(new WeakMap());

  // Stable refs for callbacks so the clusterclick handler bound on mount
  // always calls the latest version without needing to be re-bound.
  const onClusterClickRef = useRef(onClusterClick);
  const onMarkerClickRef = useRef(onMarkerClick);
  useEffect(() => {
    onClusterClickRef.current = onClusterClick;
  }, [onClusterClick]);
  useEffect(() => {
    onMarkerClickRef.current = onMarkerClick;
  }, [onMarkerClick]);

  // ----- Mount / unmount: create and destroy the cluster group -----
  useEffect(() => {
    const group = L.markerClusterGroup({ chunkedLoading: true });
    groupRef.current = group;
    map.addLayer(group);

    // Bind clusterclick once — uses the stable refs so it always has the
    // latest callback without needing to re-bind (which would require
    // recreating the group and losing cluster animation state).
    group.on('clusterclick', (e: L.LeafletEvent) => {
      const evt = e as ClusterClickEvent;
      const ids = collectClusterIds(evt.layer, (m) => idMapRef.current.get(m));
      onClusterClickRef.current(ids);
    });

    return () => {
      map.removeLayer(group);
      groupRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  // ----- Update markers whenever points change -----
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    // Clear old markers and reset the id map
    group.clearLayers();
    idMapRef.current = new WeakMap();

    for (const point of points) {
      const marker = L.marker([point.takenLat, point.takenLng], {
        icon: defaultIcon,
      });

      // Store the media id so collectClusterIds can retrieve it
      idMapRef.current.set(marker, point.id);

      marker.on('click', () => {
        onMarkerClickRef.current(point.id);
      });

      group.addLayer(marker);
    }
  }, [points]);

  // This component manages Leaflet imperatively — nothing to render.
  return null;
}
