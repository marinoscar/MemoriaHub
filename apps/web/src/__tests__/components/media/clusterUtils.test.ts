/**
 * clusterUtils — pure unit tests (no DOM, no Leaflet needed).
 *
 * Tests for collectClusterIds which maps a Leaflet MarkerCluster's child
 * markers to media ids using a caller-supplied lookup function.
 */

import { describe, it, expect, vi } from 'vitest';
import { collectClusterIds } from '../../../components/map/clusterUtils';
import type L from 'leaflet';

// ---------------------------------------------------------------------------
// Helpers — build fake Leaflet objects just enough for the function under test
// ---------------------------------------------------------------------------

/** Create a minimal fake L.Marker with a trackable identity. */
function fakeMarker(label = 'marker'): L.Marker {
  return { _label: label } as unknown as L.Marker;
}

/** Build a fake MarkerCluster whose getAllChildMarkers() returns `markers`. */
function fakeCluster(markers: L.Marker[]): L.MarkerCluster {
  return {
    getAllChildMarkers: vi.fn().mockReturnValue(markers),
  } as unknown as L.MarkerCluster;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('collectClusterIds', () => {
  it('returns an empty array when the cluster has no child markers', () => {
    const cluster = fakeCluster([]);
    const ids = collectClusterIds(cluster, () => undefined);
    expect(ids).toEqual([]);
  });

  it('returns an id for each marker that has one in the map', () => {
    const m1 = fakeMarker('a');
    const m2 = fakeMarker('b');
    const m3 = fakeMarker('c');
    const cluster = fakeCluster([m1, m2, m3]);

    const idMap = new Map<L.Marker, string>([
      [m1, 'id-1'],
      [m2, 'id-2'],
      [m3, 'id-3'],
    ]);

    const ids = collectClusterIds(cluster, (m) => idMap.get(m));

    expect(ids).toEqual(['id-1', 'id-2', 'id-3']);
  });

  it('filters out markers whose id is undefined (not tracked in the map)', () => {
    const tracked = fakeMarker('tracked');
    const untracked = fakeMarker('untracked');
    const cluster = fakeCluster([tracked, untracked]);

    const idMap = new Map<L.Marker, string>([[tracked, 'tracked-id']]);

    const ids = collectClusterIds(cluster, (m) => idMap.get(m));

    expect(ids).toEqual(['tracked-id']);
    expect(ids).not.toContain(undefined);
  });

  it('returns an empty array when no markers are tracked in the map', () => {
    const m1 = fakeMarker('x');
    const m2 = fakeMarker('y');
    const cluster = fakeCluster([m1, m2]);

    const ids = collectClusterIds(cluster, () => undefined);

    expect(ids).toEqual([]);
  });

  it('calls getAllChildMarkers exactly once', () => {
    const cluster = fakeCluster([fakeMarker()]);
    collectClusterIds(cluster, () => 'some-id');

    const mockFn = (cluster as any).getAllChildMarkers as ReturnType<typeof vi.fn>;
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it('calls idOf once per child marker', () => {
    const markers = [fakeMarker('1'), fakeMarker('2'), fakeMarker('3')];
    const cluster = fakeCluster(markers);
    const idOf = vi.fn().mockReturnValue('id');

    collectClusterIds(cluster, idOf);

    expect(idOf).toHaveBeenCalledTimes(3);
  });

  it('handles a single marker correctly', () => {
    const marker = fakeMarker('solo');
    const cluster = fakeCluster([marker]);
    const idMap = new Map<L.Marker, string>([[marker, 'solo-id']]);

    const ids = collectClusterIds(cluster, (m) => idMap.get(m));

    expect(ids).toEqual(['solo-id']);
  });

  it('preserves the order of ids from getAllChildMarkers', () => {
    const markers = [fakeMarker('a'), fakeMarker('b'), fakeMarker('c')];
    const cluster = fakeCluster(markers);

    const idMap = new Map<L.Marker, string>([
      [markers[0], 'first'],
      [markers[1], 'second'],
      [markers[2], 'third'],
    ]);

    const ids = collectClusterIds(cluster, (m) => idMap.get(m));

    expect(ids).toEqual(['first', 'second', 'third']);
  });
});
