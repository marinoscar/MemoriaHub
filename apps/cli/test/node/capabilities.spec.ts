/**
 * test/node/capabilities.spec.ts
 *
 * Unit tests for node/capabilities.ts's CompreFace-related additions:
 *   - detectCapabilities()'s bounded compreface-core /status probe
 *   - effectiveRequirements()'s provider substitution for
 *     face_detection/video_face_detection
 *   - missingRequirements()'s new third (faceProvider) parameter
 *
 * No real network calls are made: global.fetch is replaced with a jest.fn()
 * before each test and restored afterwards, matching the pattern used in
 * update-notice.spec.ts / version-check.spec.ts.
 */

import { jest } from '@jest/globals';
import {
  detectCapabilities,
  effectiveRequirements,
  missingRequirements,
  isNodeJobType,
  DEFAULT_COMPREFACE_URL,
  JOB_TYPE_REQUIREMENTS,
  NODE_JOB_TYPES,
  type CapabilityStatus,
} from '../../src/node/capabilities.js';

describe('NODE_JOB_TYPES', () => {
  it('does not advertise thumbnail_repair (global sweep job, inputUrl:null, never node-runnable)', () => {
    expect(NODE_JOB_TYPES).not.toContain('thumbnail_repair');
    expect(isNodeJobType('thumbnail_repair')).toBe(false);
    expect(Object.keys(JOB_TYPE_REQUIREMENTS)).not.toContain('thumbnail_repair');
  });

  it('keeps the per-item thumbnail_regen type intact', () => {
    expect(NODE_JOB_TYPES).toContain('thumbnail_regen');
    expect(isNodeJobType('thumbnail_regen')).toBe(true);
    expect(JOB_TYPE_REQUIREMENTS.thumbnail_regen).toEqual(['sharp', 'ffmpeg']);
  });

  it('lists exactly the node-claimable job types', () => {
    expect([...NODE_JOB_TYPES]).toEqual([
      'face_detection',
      'video_face_detection',
      'duplicate_detection',
      'metadata_extraction',
      'social_media_detection',
      'thumbnail_regen',
      'auto_tagging',
      'geocode',
    ]);
  });
});

describe('detectCapabilities — compreface probe', () => {
  const savedFetch: typeof global.fetch = global.fetch;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = savedFetch;
    jest.clearAllMocks();
  });

  it('reports available:true on HTTP 200 from the default URL', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 } as Response);

    const caps = await detectCapabilities();

    expect(caps['compreface']?.available).toBe(true);
    const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(`${DEFAULT_COMPREFACE_URL}/status`);
  });

  it('probes a custom comprefaceUrl when supplied via opts', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 } as Response);

    await detectCapabilities({ comprefaceUrl: 'http://localhost:9999' });

    const [calledUrl] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe('http://localhost:9999/status');
  });

  it('reports available:false with a descriptive detail on non-200', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 } as Response);

    const caps = await detectCapabilities();

    expect(caps['compreface']?.available).toBe(false);
    expect(caps['compreface']?.detail).toMatch(/not reachable/);
    expect(caps['compreface']?.detail).toMatch(/503/);
  });

  it('reports available:false (never throws) on a network error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

    const caps = await detectCapabilities();

    expect(caps['compreface']?.available).toBe(false);
    expect(caps['compreface']?.detail).toMatch(/ECONNREFUSED/);
  });

  it('still reports every other capability alongside compreface', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 } as Response);

    const caps = await detectCapabilities();

    expect(caps['sharp']).toBeDefined();
    expect(caps['human']).toBeDefined();
    expect(caps['ffmpeg']).toBeDefined();
    expect(caps['ffprobe']).toBeDefined();
    expect(caps['compreface']).toBeDefined();
  });
});

describe('effectiveRequirements', () => {
  it('returns JOB_TYPE_REQUIREMENTS unchanged for every type when faceProvider is human (default)', () => {
    for (const jobType of Object.keys(JOB_TYPE_REQUIREMENTS) as (keyof typeof JOB_TYPE_REQUIREMENTS)[]) {
      expect(effectiveRequirements(jobType)).toEqual(JOB_TYPE_REQUIREMENTS[jobType]);
      expect(effectiveRequirements(jobType, 'human')).toEqual(JOB_TYPE_REQUIREMENTS[jobType]);
    }
  });

  it('substitutes human -> compreface for face_detection', () => {
    expect(effectiveRequirements('face_detection', 'compreface')).toEqual(['sharp', 'compreface']);
  });

  it('substitutes human -> compreface for video_face_detection', () => {
    expect(effectiveRequirements('video_face_detection', 'compreface')).toEqual([
      'sharp',
      'compreface',
      'ffmpeg',
    ]);
  });

  it('leaves every other job type unaffected by faceProvider=compreface', () => {
    expect(effectiveRequirements('duplicate_detection', 'compreface')).toEqual(
      JOB_TYPE_REQUIREMENTS.duplicate_detection,
    );
    expect(effectiveRequirements('geocode', 'compreface')).toEqual(JOB_TYPE_REQUIREMENTS.geocode);
    expect(effectiveRequirements('auto_tagging', 'compreface')).toEqual(
      JOB_TYPE_REQUIREMENTS.auto_tagging,
    );
  });

  it('never mutates the JOB_TYPE_REQUIREMENTS source-of-truth map', () => {
    const before = JSON.stringify(JOB_TYPE_REQUIREMENTS);
    effectiveRequirements('face_detection', 'compreface');
    effectiveRequirements('video_face_detection', 'compreface');
    expect(JSON.stringify(JOB_TYPE_REQUIREMENTS)).toBe(before);
  });
});

describe('missingRequirements — faceProvider parameter', () => {
  it('defaults to human — a node with only sharp+compreface installed is NOT ready for face_detection', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true },
      human: { available: false, detail: 'not installed' },
      compreface: { available: true },
    };
    expect(missingRequirements('face_detection', caps)).toEqual(['human']);
  });

  it('with faceProvider=compreface, is satisfied when sharp+compreface are available (human not required)', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true },
      human: { available: false, detail: 'not installed' },
      compreface: { available: true },
    };
    expect(missingRequirements('face_detection', caps, 'compreface')).toEqual([]);
  });

  it('with faceProvider=compreface, reports compreface missing when the sidecar is unreachable', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true },
      human: { available: true },
      compreface: { available: false, detail: 'not reachable' },
    };
    expect(missingRequirements('face_detection', caps, 'compreface')).toEqual(['compreface']);
  });

  it('with faceProvider=compreface, applies the same substitution to video_face_detection', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true },
      human: { available: false, detail: 'not installed' },
      compreface: { available: true },
      ffmpeg: { available: true },
    };
    expect(missingRequirements('video_face_detection', caps, 'compreface')).toEqual([]);
  });

  it('does not affect job types unrelated to face detection', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true },
    };
    expect(missingRequirements('metadata_extraction', caps, 'compreface')).toEqual([]);
    expect(missingRequirements('geocode', caps, 'compreface')).toEqual([]);
  });
});
