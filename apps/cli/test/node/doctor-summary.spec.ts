/**
 * test/node/doctor-summary.spec.ts
 *
 * Unit tests for node/doctor-summary.ts — the shared, pure health
 * classification helpers used by both `memoriahub node doctor` (CLI) and the
 * TUI doctor sweep to collapse healthy rows to a one-line summary. Pure
 * functions, no mocking required.
 */

import {
  capabilityRowLevel,
  summarizeCapabilities,
  summarizeJobReadiness,
  apiAccessLevel,
  type HealthLevel,
} from '../../src/node/doctor-summary.js';
import type { CapabilityStatus } from '../../src/node/capabilities.js';
import type { ApiAccessCheckResult } from '../../src/node/doctor-checks.js';

function status(available: boolean, detail?: string): CapabilityStatus {
  return { available, detail };
}

function baseAccess(overrides: Partial<ApiAccessCheckResult> = {}): ApiAccessCheckResult {
  return {
    authOk: true,
    authDetail: 'token valid',
    nodeRegistrationOk: null,
    nodeRegistrationDetail: 'not registered locally (no nodeId in config) — skipped',
    manifestOk: true,
    manifestDetail: 'reachable — 5 model file(s) listed',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// capabilityRowLevel
// ---------------------------------------------------------------------------

describe('capabilityRowLevel', () => {
  it('is "error" when not installed at all', () => {
    const level: HealthLevel = capabilityRowLevel(status(false), status(false));
    expect(level).toBe('error');
  });

  it('is "error" even if operational somehow reports available (installed wins)', () => {
    expect(capabilityRowLevel(status(false), status(true))).toBe('error');
  });

  it('is "warn" when installed but not yet operational', () => {
    expect(capabilityRowLevel(status(true), status(false))).toBe('warn');
  });

  it('is "ok" when installed and operational', () => {
    expect(capabilityRowLevel(status(true), status(true))).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// summarizeCapabilities
// ---------------------------------------------------------------------------

describe('summarizeCapabilities', () => {
  it('classifies a mixed set of capabilities into issues/okCount/totalCount', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: status(true, 'sharp'),
      human: status(true, '@vladmandic/human'),
      onnxruntime: status(false, 'onnxruntime-node not installed'),
      ffmpeg: status(true, 'ffmpeg on PATH'),
    };
    const operational: Record<string, CapabilityStatus> = {
      sharp: status(true),
      human: status(false, 'model not downloaded yet'),
      onnxruntime: status(false),
      ffmpeg: status(true),
    };

    const summary = summarizeCapabilities(caps, operational);

    expect(summary.totalCount).toBe(4);
    expect(summary.okCount).toBe(2); // sharp, ffmpeg
    expect(summary.issues).toHaveLength(2);
    expect(summary.issues.map((r) => r.key).sort()).toEqual(['human', 'onnxruntime']);
    expect(summary.issues.find((r) => r.key === 'human')?.level).toBe('warn');
    expect(summary.issues.find((r) => r.key === 'onnxruntime')?.level).toBe('error');
    // rows preserves input order and includes every capability
    expect(summary.rows.map((r) => r.key)).toEqual(['sharp', 'human', 'onnxruntime', 'ffmpeg']);
  });

  it('falls back to the presence status when a key is absent from operational (mirrors `operational[key] ?? status`)', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: status(true, 'sharp'),
    };
    // `operational` has no entry for 'sharp' at all — e.g. self-tests never
    // ran for it, or a partial self-test result.
    const operational: Record<string, CapabilityStatus> = {};

    const summary = summarizeCapabilities(caps, operational);

    expect(summary.totalCount).toBe(1);
    expect(summary.issues).toHaveLength(0);
    expect(summary.okCount).toBe(1);
    expect(summary.rows[0]?.operational).toEqual(status(true, 'sharp'));
    expect(summary.rows[0]?.level).toBe('ok');
  });

  it('reports all-healthy input with zero issues', () => {
    const caps: Record<string, CapabilityStatus> = {
      sharp: status(true),
      ffmpeg: status(true),
    };
    const operational: Record<string, CapabilityStatus> = {
      sharp: status(true),
      ffmpeg: status(true),
    };
    const summary = summarizeCapabilities(caps, operational);
    expect(summary.issues).toHaveLength(0);
    expect(summary.okCount).toBe(2);
    expect(summary.totalCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// summarizeJobReadiness
// ---------------------------------------------------------------------------

describe('summarizeJobReadiness', () => {
  it('splits mixed ready/not-ready rows into issues vs. readyCount/totalCount', () => {
    const rows = [
      { type: 'face_detection', ready: true, missing: [] as string[] },
      { type: 'video_face_detection', ready: false, missing: ['ffmpeg'] },
      { type: 'geocode', ready: true, missing: [] as string[] },
      { type: 'auto_tagging', ready: false, missing: ['sharp'] },
    ];

    const summary = summarizeJobReadiness(rows);

    expect(summary.totalCount).toBe(4);
    expect(summary.readyCount).toBe(2);
    expect(summary.issues).toHaveLength(2);
    expect(summary.issues.map((r) => r.type)).toEqual(['video_face_detection', 'auto_tagging']);
  });

  it('reports zero issues when every row is ready', () => {
    const rows = [
      { type: 'geocode', ready: true, missing: [] as string[] },
      { type: 'metadata_extraction', ready: true, missing: [] as string[] },
    ];
    const summary = summarizeJobReadiness(rows);
    expect(summary.issues).toHaveLength(0);
    expect(summary.readyCount).toBe(2);
    expect(summary.totalCount).toBe(2);
  });

  it('handles an empty row list', () => {
    const summary = summarizeJobReadiness([]);
    expect(summary.issues).toHaveLength(0);
    expect(summary.readyCount).toBe(0);
    expect(summary.totalCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// apiAccessLevel
// ---------------------------------------------------------------------------

describe('apiAccessLevel', () => {
  it('is "error" when auth failed', () => {
    const access = baseAccess({ authOk: false, authDetail: 'invalid token' });
    expect(apiAccessLevel(access)).toBe('error');
  });

  it('is "error" even when other sub-checks are fine, if auth failed', () => {
    const access = baseAccess({
      authOk: false,
      nodeRegistrationOk: true,
      manifestOk: true,
    });
    expect(apiAccessLevel(access)).toBe('error');
  });

  it('is "warn" when node registration is explicitly invalid (false, not null)', () => {
    const access = baseAccess({ nodeRegistrationOk: false });
    expect(apiAccessLevel(access)).toBe('warn');
  });

  it('is "warn" when the model manifest is unreachable', () => {
    const access = baseAccess({ manifestOk: false });
    expect(apiAccessLevel(access)).toBe('warn');
  });

  it('is "ok" when the node is simply not registered locally (nodeRegistrationOk === null) — not a warning', () => {
    const access = baseAccess({ nodeRegistrationOk: null });
    expect(apiAccessLevel(access)).toBe('ok');
  });

  it('is "ok" when everything checks out, including a confirmed valid registration', () => {
    const access = baseAccess({ nodeRegistrationOk: true });
    expect(apiAccessLevel(access)).toBe('ok');
  });
});
