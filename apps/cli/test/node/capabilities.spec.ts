/**
 * test/node/capabilities.spec.ts
 *
 * Unit tests for node/capabilities.ts's CompreFace-related additions:
 *   - detectCapabilities()'s bounded compreface-core /status probe
 *   - effectiveRequirements() — an identity function over
 *     JOB_TYPE_REQUIREMENTS since CompreFace is the only supported
 *     face-detection provider (issue #113 removed Human + AWS Rekognition);
 *     the `faceProvider` parameter is retained only as a structural hook for
 *     a possible future provider and accepts `'compreface'` exclusively.
 *   - missingRequirements()'s `faceProvider` parameter (same 'compreface'-only
 *     contract, defaulted so 2-argument call sites keep working)
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
      'video_auto_tagging',
      'geocode',
      'workflow_execute_batch',
    ]);
  });

  it('requires ffmpeg AND ffprobe for video_auto_tagging — a node without them must never claim it', () => {
    // Frame extraction (and optional audio extraction) shell out to ffmpeg;
    // requirements are per TYPE for exactly this reason, which is also why
    // video tagging is a separate job type from auto_tagging (['sharp']).
    expect(JOB_TYPE_REQUIREMENTS.video_auto_tagging).toEqual(['sharp', 'ffmpeg', 'ffprobe']);
    expect(JOB_TYPE_REQUIREMENTS.auto_tagging).toEqual(['sharp']);
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
    expect(caps['onnxruntime']).toBeDefined();
    expect(caps['tesseract']).toBeDefined();
    expect(caps['ffmpeg']).toBeDefined();
    expect(caps['ffprobe']).toBeDefined();
    expect(caps['compreface']).toBeDefined();
  });
});

describe('effectiveRequirements', () => {
  it('returns JOB_TYPE_REQUIREMENTS unchanged for every type (identity function, faceProvider defaults to compreface)', () => {
    for (const jobType of Object.keys(JOB_TYPE_REQUIREMENTS) as (keyof typeof JOB_TYPE_REQUIREMENTS)[]) {
      expect(effectiveRequirements(jobType)).toEqual(JOB_TYPE_REQUIREMENTS[jobType]);
      expect(effectiveRequirements(jobType, 'compreface')).toEqual(JOB_TYPE_REQUIREMENTS[jobType]);
    }
  });

  it('face_detection already requires compreface directly (no provider substitution needed)', () => {
    expect(effectiveRequirements('face_detection')).toEqual(['sharp', 'compreface']);
  });

  it('video_face_detection already requires compreface directly (no provider substitution needed)', () => {
    expect(effectiveRequirements('video_face_detection')).toEqual(['sharp', 'compreface', 'ffmpeg']);
  });

  it('leaves every other job type unaffected', () => {
    expect(effectiveRequirements('duplicate_detection')).toEqual(
      JOB_TYPE_REQUIREMENTS.duplicate_detection,
    );
    expect(effectiveRequirements('geocode')).toEqual(JOB_TYPE_REQUIREMENTS.geocode);
    expect(effectiveRequirements('auto_tagging')).toEqual(JOB_TYPE_REQUIREMENTS.auto_tagging);
  });

  it('never mutates the JOB_TYPE_REQUIREMENTS source-of-truth map', () => {
    const before = JSON.stringify(JOB_TYPE_REQUIREMENTS);
    effectiveRequirements('face_detection', 'compreface');
    effectiveRequirements('video_face_detection', 'compreface');
    expect(JSON.stringify(JOB_TYPE_REQUIREMENTS)).toBe(before);
  });
});

describe('missingRequirements — faceProvider parameter', () => {
  it('defaults to compreface — a node without a reachable sidecar is NOT ready for face_detection', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true },
      compreface: { available: false, detail: 'not reachable' },
    };
    expect(missingRequirements('face_detection', caps)).toEqual(['compreface']);
  });

  it('is satisfied when sharp+compreface are both available', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true },
      compreface: { available: true },
    };
    expect(missingRequirements('face_detection', caps, 'compreface')).toEqual([]);
  });

  it('reports compreface missing when the sidecar is unreachable', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true },
      compreface: { available: false, detail: 'not reachable' },
    };
    expect(missingRequirements('face_detection', caps, 'compreface')).toEqual(['compreface']);
  });

  it('applies the same requirement to video_face_detection', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true },
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
