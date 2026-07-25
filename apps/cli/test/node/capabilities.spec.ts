/**
 * test/node/capabilities.spec.ts
 *
 * Unit tests for node/capabilities.ts's CompreFace-related surface:
 *   - detectCapabilities()'s bounded compreface-core /status probe
 *   - JOB_TYPE_REQUIREMENTS gating the two face job types on the `compreface`
 *     sidecar capability (CompreFace is a node's only face provider — #113)
 *   - missingRequirements()
 *
 * No real network calls are made: global.fetch is replaced with a jest.fn()
 * before each test and restored afterwards, matching the pattern used in
 * update-notice.spec.ts / version-check.spec.ts.
 */

import { jest } from '@jest/globals';
import {
  detectCapabilities,
  missingRequirements,
  isNodeJobType,
  DEFAULT_COMPREFACE_URL,
  JOB_TYPE_REQUIREMENTS,
  NATIVE_MODULES,
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
      'workflow_execute_batch',
    ]);
  });
});

describe('NATIVE_MODULES', () => {
  it('carries no Human/TensorFlow entries — the Human pipeline is gone (issue #113)', () => {
    expect(Object.keys(NATIVE_MODULES).sort()).toEqual(['onnxruntime', 'sharp', 'tesseract']);
    expect(Object.values(NATIVE_MODULES)).not.toContain('@vladmandic/human');
  });

  it('does not treat compreface as an npm module (it is an HTTP sidecar probe)', () => {
    expect(NATIVE_MODULES).not.toHaveProperty('compreface');
  });
});

describe('JOB_TYPE_REQUIREMENTS — face types', () => {
  it('gates face_detection on sharp + the compreface sidecar', () => {
    expect(JOB_TYPE_REQUIREMENTS.face_detection).toEqual(['sharp', 'compreface']);
  });

  it('gates video_face_detection on sharp + compreface + ffmpeg', () => {
    expect(JOB_TYPE_REQUIREMENTS.video_face_detection).toEqual(['sharp', 'compreface', 'ffmpeg']);
  });

  it('never lists a human capability for any job type', () => {
    for (const reqs of Object.values(JOB_TYPE_REQUIREMENTS)) {
      expect(reqs).not.toContain('human');
    }
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
    expect(caps['ffmpeg']).toBeDefined();
    expect(caps['ffprobe']).toBeDefined();
    expect(caps['compreface']).toBeDefined();
    expect(caps['human']).toBeUndefined();
  });
});

describe('missingRequirements', () => {
  it('is satisfied for face_detection when sharp + compreface are available', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true },
      compreface: { available: true },
    };
    expect(missingRequirements('face_detection', caps)).toEqual([]);
  });

  it('reports compreface missing when the sidecar is unreachable', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true },
      compreface: { available: false, detail: 'not reachable' },
    };
    expect(missingRequirements('face_detection', caps)).toEqual(['compreface']);
  });

  it('applies the same gating to video_face_detection', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true },
      compreface: { available: true },
      ffmpeg: { available: true },
    };
    expect(missingRequirements('video_face_detection', caps)).toEqual([]);
  });

  it('reports every missing requirement for video_face_detection', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true },
      compreface: { available: false, detail: 'not reachable' },
      ffmpeg: { available: false },
    };
    expect(missingRequirements('video_face_detection', caps)).toEqual(['compreface', 'ffmpeg']);
  });

  it('does not affect job types unrelated to face detection', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true },
    };
    expect(missingRequirements('metadata_extraction', caps)).toEqual([]);
    expect(missingRequirements('geocode', caps)).toEqual([]);
  });
});
