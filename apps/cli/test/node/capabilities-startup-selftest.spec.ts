/**
 * test/node/capabilities-startup-selftest.spec.ts
 *
 * Unit tests for node/capabilities.ts's issue #148 additions:
 *   - evaluateStartupSelfTest() — decides which operational self-test failures
 *     BLOCK node startup (required by an eligible job type) vs. are DEGRADE-only
 *     (optional/degradable capability, e.g. tesseract OCR, onnxruntime CLIP).
 *   - mergeOperationalCapabilities() — merges a live presence probe with a
 *     cached startup operational self-test snapshot into the heartbeat payload,
 *     staying backward-compatible with the pre-#148 presence-only shape.
 *
 * Pure functions — no mocking required, no network/filesystem access.
 */

import {
  evaluateStartupSelfTest,
  mergeOperationalCapabilities,
  type CapabilityStatus,
} from '../../src/node/capabilities.js';

describe('evaluateStartupSelfTest', () => {
  it('is ok with no blocking failures or degrades when every required capability passes its operational self-test', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true, detail: 'sharp' },
      human: { available: true, detail: '@vladmandic/human' },
    };
    const operationalResults: Record<string, CapabilityStatus> = {
      sharp: { available: true, detail: 'roundtrip ok' },
      human: { available: true, detail: 'ran end-to-end' },
    };

    const result = evaluateStartupSelfTest(caps, operationalResults, ['face_detection']);

    expect(result.ok).toBe(true);
    expect(result.blockingFailures).toEqual([]);
    expect(result.degraded).toEqual([]);
  });

  it('reports a non-empty blockingFailures and ok:false when a required capability fails its operational self-test', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true, detail: 'sharp' },
      human: { available: true, detail: '@vladmandic/human' },
    };
    const operationalResults: Record<string, CapabilityStatus> = {
      sharp: { available: true, detail: 'roundtrip ok' },
      human: { available: false, detail: 'Human self-test failed: model load error' },
    };

    const result = evaluateStartupSelfTest(caps, operationalResults, ['face_detection']);

    expect(result.ok).toBe(false);
    expect(result.blockingFailures).toEqual([
      {
        capability: 'human',
        jobType: 'face_detection',
        detail: 'Human self-test failed: model load error',
      },
    ]);
    expect(result.degraded).toEqual([]);
  });

  it('treats a tesseract (OCR) operational failure as a non-blocking degrade when eligibleTypes only needs Tier-1 social_media_detection', () => {
    const caps: Record<string, CapabilityStatus> = {
      ffprobe: { available: true, detail: 'ffprobe on PATH' },
      tesseract: { available: true, detail: 'tesseract.js' },
    };
    const operationalResults: Record<string, CapabilityStatus> = {
      ffprobe: { available: true, detail: 'ffprobe on PATH' },
      tesseract: { available: false, detail: 'language data not present' },
    };

    const result = evaluateStartupSelfTest(caps, operationalResults, ['social_media_detection']);

    expect(result.ok).toBe(true);
    expect(result.blockingFailures).toEqual([]);
    expect(result.degraded).toEqual([
      { capability: 'tesseract', detail: 'language data not present' },
    ]);
  });

  it('treats a tesseract operational failure as a non-blocking degrade even when eligibleTypes does not include social_media_detection at all', () => {
    // tesseract is never a hard requirement for any NODE_JOB_TYPE (it's always
    // optional/degraded — Tier-2 OCR only), so this holds regardless of eligibleTypes.
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true, detail: 'sharp' },
      tesseract: { available: true, detail: 'tesseract.js' },
    };
    const operationalResults: Record<string, CapabilityStatus> = {
      sharp: { available: true, detail: 'roundtrip ok' },
      tesseract: { available: false, detail: 'language data not present' },
    };

    const result = evaluateStartupSelfTest(caps, operationalResults, ['auto_tagging']);

    expect(result.ok).toBe(true);
    expect(result.blockingFailures).toEqual([]);
    expect(result.degraded).toEqual([
      { capability: 'tesseract', detail: 'language data not present' },
    ]);
  });

  it('gates by eligibleTypes: the same failing capability blocks when required by an eligible type, but only degrades when no eligible type needs it', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true, detail: 'sharp' },
    };
    const operationalResults: Record<string, CapabilityStatus> = {
      sharp: { available: false, detail: 'sharp self-test failed' },
    };

    // auto_tagging requires sharp -> blocks.
    const blockingResult = evaluateStartupSelfTest(caps, operationalResults, ['auto_tagging']);
    expect(blockingResult.ok).toBe(false);
    expect(blockingResult.blockingFailures).toEqual([
      { capability: 'sharp', jobType: 'auto_tagging', detail: 'sharp self-test failed' },
    ]);
    expect(blockingResult.degraded).toEqual([]);

    // geocode has NO capability requirements -> the identical sharp failure is
    // only a degrade, never a blocker, when no eligible type needs sharp.
    const degradeResult = evaluateStartupSelfTest(caps, operationalResults, ['geocode']);
    expect(degradeResult.ok).toBe(true);
    expect(degradeResult.blockingFailures).toEqual([]);
    expect(degradeResult.degraded).toEqual([
      { capability: 'sharp', detail: 'sharp self-test failed' },
    ]);
  });

  it('filters out eligibleTypes entries that are not valid NodeJobTypes', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true },
    };
    const operationalResults: Record<string, CapabilityStatus> = {
      sharp: { available: false, detail: 'sharp self-test failed' },
    };

    // 'thumbnail_repair' is a global sweep type, never node-eligible; it should
    // be filtered by isNodeJobType and contribute no requirements.
    const result = evaluateStartupSelfTest(caps, operationalResults, ['thumbnail_repair']);

    expect(result.ok).toBe(true);
    expect(result.blockingFailures).toEqual([]);
    expect(result.degraded).toEqual([{ capability: 'sharp', detail: 'sharp self-test failed' }]);
  });

  it('substitutes the compreface capability for human when faceProvider=compreface', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true },
      compreface: { available: true },
    };
    const operationalResults: Record<string, CapabilityStatus> = {
      sharp: { available: true },
      compreface: { available: false, detail: 'compreface self-test failed: HTTP 503' },
    };

    const result = evaluateStartupSelfTest(
      caps,
      operationalResults,
      ['face_detection'],
      'compreface',
    );

    expect(result.ok).toBe(false);
    expect(result.blockingFailures).toEqual([
      {
        capability: 'compreface',
        jobType: 'face_detection',
        detail: 'compreface self-test failed: HTTP 503',
      },
    ]);
  });

  it('never degrades a capability whose operational result is missing entirely (not tested)', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: { available: true, detail: 'sharp' },
    };
    // sharp was probed present but never operationally tested (absent from
    // operationalResults) — should not appear in blockingFailures OR degraded.
    const operationalResults: Record<string, CapabilityStatus> = {};

    const result = evaluateStartupSelfTest(caps, operationalResults, ['geocode']);

    expect(result.ok).toBe(true);
    expect(result.blockingFailures).toEqual([]);
    expect(result.degraded).toEqual([]);
  });
});

describe('mergeOperationalCapabilities', () => {
  it('leaves a presence entry unchanged (no operational field added) when no operational snapshot is supplied', () => {
    const presence: Record<string, CapabilityStatus> = {
      sharp: { available: true, detail: 'sharp' },
      human: { available: false, detail: '@vladmandic/human not installed' },
    };

    const merged = mergeOperationalCapabilities(presence);

    expect(merged).toEqual({
      sharp: { available: true, detail: 'sharp' },
      human: { available: false, detail: '@vladmandic/human not installed' },
    });
    expect(merged['sharp']).not.toHaveProperty('operational');
    expect(merged['human']).not.toHaveProperty('operational');
  });

  it('overlays operational:false plus operationalDetail onto a present capability', () => {
    const presence: Record<string, CapabilityStatus> = {
      human: { available: true, detail: '@vladmandic/human' },
    };
    const operational: Record<string, CapabilityStatus> = {
      human: { available: false, detail: 'Human self-test failed: model load error' },
    };

    const merged = mergeOperationalCapabilities(presence, operational);

    expect(merged['human']).toEqual({
      available: true,
      detail: '@vladmandic/human',
      operational: false,
      operationalDetail: 'Human self-test failed: model load error',
    });
  });

  it('overlays operational:true without an operationalDetail key when the operational result has no detail', () => {
    const presence: Record<string, CapabilityStatus> = {
      sharp: { available: true, detail: 'sharp' },
    };
    const operational: Record<string, CapabilityStatus> = {
      sharp: { available: true },
    };

    const merged = mergeOperationalCapabilities(presence, operational);

    expect(merged['sharp']).toEqual({ available: true, detail: 'sharp', operational: true });
    expect(merged['sharp']).not.toHaveProperty('operationalDetail');
  });

  it('leaves a capability unchanged when it is absent from the operational snapshot (partial/backward-compat snapshot)', () => {
    const presence: Record<string, CapabilityStatus> = {
      sharp: { available: true, detail: 'sharp' },
      human: { available: true, detail: '@vladmandic/human' },
    };
    // Only sharp was operationally tested; human is absent (e.g. an older
    // snapshot, or a capability the startup self-test never covers).
    const operational: Record<string, CapabilityStatus> = {
      sharp: { available: true, detail: 'roundtrip ok' },
    };

    const merged = mergeOperationalCapabilities(presence, operational);

    expect(merged['sharp']).toEqual({
      available: true,
      detail: 'sharp',
      operational: true,
      operationalDetail: 'roundtrip ok',
    });
    // human is passed through exactly as in presence — presence-only shape.
    expect(merged['human']).toEqual({ available: true, detail: '@vladmandic/human' });
    expect(merged['human']).not.toHaveProperty('operational');
  });

  it('never consults the operational snapshot for a capability whose presence is unavailable', () => {
    const presence: Record<string, CapabilityStatus> = {
      human: { available: false, detail: '@vladmandic/human not installed' },
    };
    // Even if a (stale/nonsensical) operational entry exists for a
    // not-installed capability, it must not be applied.
    const operational: Record<string, CapabilityStatus> = {
      human: { available: true, detail: 'ran end-to-end' },
    };

    const merged = mergeOperationalCapabilities(presence, operational);

    expect(merged['human']).toEqual({
      available: false,
      detail: '@vladmandic/human not installed',
    });
    expect(merged['human']).not.toHaveProperty('operational');
  });

  it('returns an empty object for an empty presence map regardless of the operational snapshot', () => {
    expect(mergeOperationalCapabilities({}, { sharp: { available: true } })).toEqual({});
    expect(mergeOperationalCapabilities({})).toEqual({});
  });
});
