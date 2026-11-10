/**
 * The span attributes MemoriaHub node executors relay (RETRO-T4, #629).
 *
 * The platform's `POST /api/nodes/:id/telemetry` re-emits a node's `job.app.<phase>` spans and keeps
 * only the attribute keys an app registered (`registerNodeSpanAttribute`), by type. This pins what
 * MemoriaHub registers, and that an unregistered key, a wrong-typed value and a path- or URL-shaped
 * string are dropped, not an error.
 */

import { resolveRelayedAttribute, NODE_SPAN_ATTRIBUTE_KEY_PATTERN } from '@marinoscar/platform-api/nodes';

import { APP_NODE_SPAN_ATTRIBUTES } from '../../src/app-registrations/jobs';

describe('MemoriaHub node span attributes', () => {
  it('registers every attribute the executors emit, camelCase keys the platform accepts', () => {
    const keys = APP_NODE_SPAN_ATTRIBUTES.map((a) => a.key).sort();
    expect(keys).toEqual(
      ['actions', 'codec', 'embeddingDims', 'faces', 'frames', 'geoProvider', 'height', 'ocrFrames', 'width'].sort(),
    );
    for (const key of keys) expect(key).toMatch(NODE_SPAN_ATTRIBUTE_KEY_PATTERN);
    expect(APP_NODE_SPAN_ATTRIBUTES.length).toBeLessThanOrEqual(16);
  });

  it('relays a registered integer and a registered token', () => {
    expect(resolveRelayedAttribute('frames', 12)).toBeDefined();
    expect(resolveRelayedAttribute('faces', 0)).toBeDefined();
    expect(resolveRelayedAttribute('codec', 'h264')).toBeDefined();
    expect(resolveRelayedAttribute('geoProvider', 'nominatim')).toBeDefined();
  });

  it('drops, without throwing, an unregistered key, a wrong type or a non-token string', () => {
    expect(resolveRelayedAttribute('fileName', 3)).toBeUndefined();
    expect(resolveRelayedAttribute('frames', 'twelve')).toBeUndefined();
    expect(resolveRelayedAttribute('frames', -1)).toBeUndefined();
    expect(resolveRelayedAttribute('frames', 1.5)).toBeUndefined();
    expect(resolveRelayedAttribute('codec', '/media/x/clip.mov')).toBeUndefined();
    expect(resolveRelayedAttribute('codec', 'https://host.example.test/a')).toBeUndefined();
    expect(resolveRelayedAttribute('geoProvider', 'a b')).toBeUndefined();
  });
});
