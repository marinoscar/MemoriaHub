// =============================================================================
// MemoriaHub's verdict rules, gauges and import-progress panel (RETRO-T3, #628)
// =============================================================================

import type { DashboardVerdict } from '@marinoscar/platform-api/telemetry';
import type { AppGaugeContext } from '@marinoscar/platform-api/otel-core';
import { appMetricRegistry } from '@marinoscar/platform-api/otel-core';
import { registerPlatformHostAppMetrics } from '@marinoscar/platform-api/host';
import type { Meter } from '@opentelemetry/api';

import { capabilityOk, countCapabilities } from '../../src/platform-extensions/telemetry/gauges/fleet.gauges';
import { memoizedRead } from '../../src/platform-extensions/telemetry/gauges/memoized-read';
import { buildImportProgress } from '../../src/platform-extensions/telemetry/import-progress.dashboard-panel';
import { MemoriaHubGaugesService } from '../../src/platform-extensions/telemetry/memoriahub-gauges.service';
import { MEMORIAHUB_APP_METRICS } from '../../src/platform-extensions/telemetry/memoriahub-metrics.manifest';
import type {
  MemoriaHubTelemetrySignals,
  MemoriaHubVerdictSignals,
} from '../../src/platform-extensions/telemetry/memoriahub-telemetry-signals.service';
import { applyMemoriaHubRules, MemoriaHubVerdictPolicy } from '../../src/platform-extensions/telemetry/memoriahub-verdict.policy';

if (!appMetricRegistry.has('mediaUploads')) registerPlatformHostAppMetrics(MEMORIAHUB_APP_METRICS);

const HEALTHY: DashboardVerdict = { level: 'healthy', reasons: [] };

function signals(patch: Partial<MemoriaHubVerdictSignals> = {}): MemoriaHubVerdictSignals {
  return {
    at: 10_000_000,
    settled: [],
    oldestPending: [],
    backlogSamples: [],
    fleet: { registered: 0, online: 0, nodeEligiblePending: 0 },
    ...patch,
  };
}

describe('MemoriaHub verdict rules', () => {
  it('adds nothing on quiet signals, and nothing before the first read', () => {
    expect(applyMemoriaHubRules(HEALTHY, signals())).toEqual(HEALTHY);
    expect(applyMemoriaHubRules(HEALTHY, null)).toEqual(HEALTHY);
  });

  it('leaves no_data alone', () => {
    const noData: DashboardVerdict = { level: 'no_data', reasons: ['No telemetry received recently'] };
    const busy = signals({ settled: [{ type: 'face_detection', succeeded: 0, failed: 60 }] });
    expect(applyMemoriaHubRules(noData, busy)).toEqual(noData);
  });

  describe('enrichment failure ratio', () => {
    it('is degraded above 10 % and critical above 25 %, per job type', () => {
      const degraded = applyMemoriaHubRules(HEALTHY, signals({ settled: [{ type: 'geocode', succeeded: 85, failed: 15 }] }));
      expect(degraded.level).toBe('degraded');
      expect(degraded.reasons[0]).toContain('geocode failed 15 %');

      const critical = applyMemoriaHubRules(HEALTHY, signals({ settled: [{ type: 'face_detection', succeeded: 0, failed: 60 }] }));
      expect(critical.level).toBe('critical');
    });

    it('needs at least 50 settled jobs', () => {
      expect(applyMemoriaHubRules(HEALTHY, signals({ settled: [{ type: 'geocode', succeeded: 0, failed: 49 }] })).level).toBe(
        'healthy',
      );
    });
  });

  it('judges the oldest pending upload job: > 30 min degraded, > 2 h critical', () => {
    expect(applyMemoriaHubRules(HEALTHY, signals({ oldestPending: [{ type: 'auto_tagging', ageMinutes: 31 }] })).level).toBe(
      'degraded',
    );
    expect(applyMemoriaHubRules(HEALTHY, signals({ oldestPending: [{ type: 'auto_tagging', ageMinutes: 121 }] })).level).toBe(
      'critical',
    );
    expect(applyMemoriaHubRules(HEALTHY, signals({ oldestPending: [{ type: 'auto_tagging', ageMinutes: 29 }] })).level).toBe(
      'healthy',
    );
  });

  describe('sustained processing backlog', () => {
    const span = (values: number[], stepMinutes: number) =>
      values.map((processing, i) => ({ at: i * stepMinutes * 60_000, processing }));

    it('fires only when every sample over a long-enough span is above the bound', () => {
      expect(applyMemoriaHubRules(HEALTHY, signals({ backlogSamples: span([60, 70, 80], 10) })).level).toBe('degraded');
      expect(applyMemoriaHubRules(HEALTHY, signals({ backlogSamples: span([600, 700], 20) })).level).toBe('critical');
      // One dip below the bound: not sustained.
      expect(applyMemoriaHubRules(HEALTHY, signals({ backlogSamples: span([60, 40, 80], 10) })).level).toBe('healthy');
      // Too short a span to call it sustained.
      expect(applyMemoriaHubRules(HEALTHY, signals({ backlogSamples: span([600, 700], 5) })).level).toBe('healthy');
    });
  });

  it('flags an idle fleet only when nodes are registered and none is online', () => {
    const idle = signals({ fleet: { registered: 2, online: 0, nodeEligiblePending: 501 } });
    expect(applyMemoriaHubRules(HEALTHY, idle).level).toBe('degraded');
    expect(applyMemoriaHubRules(HEALTHY, signals({ fleet: { registered: 0, online: 0, nodeEligiblePending: 900 } })).level).toBe(
      'healthy',
    );
    expect(applyMemoriaHubRules(HEALTHY, signals({ fleet: { registered: 2, online: 1, nodeEligiblePending: 900 } })).level).toBe(
      'healthy',
    );
  });

  it('never lowers a level and keeps the platform reasons first', () => {
    const critical: DashboardVerdict = { level: 'critical', reasons: ['platform reason'] };
    const result = applyMemoriaHubRules(critical, signals({ oldestPending: [{ type: 'auto_tagging', ageMinutes: 40 }] }));
    expect(result.level).toBe('critical');
    expect(result.reasons[0]).toBe('platform reason');
    expect(result.reasons).toHaveLength(2);
  });

  it('the policy delegates to the platform policy first', () => {
    const platform = { compute: jest.fn().mockReturnValue({ level: 'degraded', reasons: ['p95'] }) };
    const reads = { verdictSignals: () => signals({ settled: [{ type: 'geocode', succeeded: 0, failed: 60 }] }) };
    const policy = new MemoriaHubVerdictPolicy(platform as never, reads as unknown as MemoriaHubTelemetrySignals);
    const verdict = policy.compute({} as never, {} as never);
    expect(platform.compute).toHaveBeenCalledTimes(1);
    expect(verdict.level).toBe('critical');
    expect(verdict.reasons[0]).toBe('p95');
  });
});

describe('MemoriaHub gauges', () => {
  function recordingMeter() {
    const callbacks = new Map<string, (result: { observe: (v: number, a?: unknown) => void }) => Promise<void>>();
    const meter = {
      createObservableGauge: (name: string) => ({
        addCallback: (cb: (result: { observe: (v: number, a?: unknown) => void }) => Promise<void>) => callbacks.set(name, cb),
        removeCallback: () => undefined,
      }),
    } as unknown as Meter;
    return { meter, callbacks };
  }

  function readsSpy() {
    const read = <T>(value: T) => ({ get: jest.fn().mockResolvedValue(value) });
    return {
      backlog: read({ pending: 1, uploading: 2, processing: 3 }),
      pending: read({ faces: 4, tags: 0, metadata: 0, geocode: 0, social: 0 }),
      storage: read({ bytes: [{ provider: 'minio', kind: 'photo', bytes: 10 }], trashBytes: 5 }),
      capabilities: read({ ffmpeg: { ok: 1, missing: 0 } }),
    };
  }

  it('registers the five gauges and reads nothing while the export gate is closed', async () => {
    const { meter, callbacks } = recordingMeter();
    const reads = readsSpy();
    const service = new MemoriaHubGaugesService(reads as unknown as MemoriaHubTelemetrySignals);
    const context = { meter, now: () => 0, gateOpen: () => false } as AppGaugeContext;
    expect(service.register(context)).toBe(true);
    expect([...callbacks.keys()].sort()).toEqual(
      [
        'app.enrichment.pending',
        'app.media.processing.backlog',
        'app.nodes.capability',
        'app.storage.bytes',
        'app.storage.trash.bytes',
      ].sort(),
    );
    const observe = jest.fn();
    for (const cb of callbacks.values()) await cb({ observe });
    expect(observe).not.toHaveBeenCalled();
    for (const read of Object.values(reads)) expect(read.get).not.toHaveBeenCalled();
    // Idempotent.
    expect(service.register(context)).toBe(false);
  });

  it('observes enum labels only while the gate is open (an unknown provider reads as other)', async () => {
    const { meter, callbacks } = recordingMeter();
    const service = new MemoriaHubGaugesService(readsSpy() as unknown as MemoriaHubTelemetrySignals);
    service.register({ meter, now: () => 0, gateOpen: () => true } as AppGaugeContext);
    const observed: Array<[string, number, unknown]> = [];
    for (const [name, cb] of callbacks) await cb({ observe: (v, a) => observed.push([name, v, a]) });
    expect(observed).toEqual(
      expect.arrayContaining([
        ['app.media.processing.backlog', 3, { status: 'processing' }],
        ['app.enrichment.pending', 4, { stage: 'faces' }],
        ['app.storage.bytes', 10, { provider: 'other', kind: 'photo' }],
        ['app.storage.trash.bytes', 5, undefined],
        ['app.nodes.capability', 1, { capability: 'ffmpeg', state: 'ok' }],
        ['app.nodes.capability', 0, { capability: 'ffmpeg', state: 'missing' }],
      ]),
    );
  });

  it('memoizes a read for 60 s and never throws', async () => {
    let clock = 0;
    const read = jest.fn().mockResolvedValue(7);
    const memo = memoizedRead('x', read, { now: () => clock, logger: { warn: jest.fn(), debug: jest.fn() } });
    expect(await memo.get()).toBe(7);
    clock = 59_000;
    expect(await memo.get()).toBe(7);
    expect(read).toHaveBeenCalledTimes(1);
    clock = 61_000;
    await memo.get();
    expect(read).toHaveBeenCalledTimes(2);

    const failing = memoizedRead('y', () => Promise.reject(new Error('down')), { logger: { warn: jest.fn(), debug: jest.fn() } });
    await expect(failing.get()).resolves.toBeNull();
  });

  it('reads node capabilities from the tolerant capability summary', () => {
    expect(capabilityOk({ ffmpeg: 'ok', tesseract: { status: 'error' } }, 'ffmpeg')).toBe(true);
    expect(capabilityOk({ ffmpeg: 'ok', tesseract: { status: 'error' } }, 'tesseract')).toBe(false);
    expect(capabilityOk({ checks: [{ key: 'ocr', status: 'ok' }] }, 'tesseract')).toBe(true);
    expect(capabilityOk(null, 'clip')).toBe(false);
    expect(countCapabilities([{ capabilities: { clip: 'ok' } }, { capabilities: {} }]).clip).toEqual({ ok: 1, missing: 1 });
  });
});

describe('import progress panel', () => {
  it('derives done, throughput and ETA per stage', () => {
    const payload = buildImportProgress({
      uploads: new Map([['', 2000]]),
      pending: new Map([
        ['faces', 600],
        ['tags', 0],
      ]),
      settled: new Map([
        ['face_detection', 300],
        ['video_face_detection', 300],
      ]),
      oldest: new Map([['auto_tagging', 125.4]]),
    });
    expect(payload.available).toBe(true);
    expect(payload.uploads).toBe(2000);
    const faces = payload.stages.find((stage) => stage.stage === 'faces')!;
    expect(faces).toEqual({ stage: 'faces', pending: 600, done: 1400, perMinute: 10, etaMinutes: 60 });
    expect(payload.stages.find((stage) => stage.stage === 'tags')!.etaMinutes).toBe(0);
    expect(payload.oldestPending).toEqual([{ jobType: 'auto_tagging', ageSeconds: 125 }]);
  });

  it('says "no data yet" when no table exists', () => {
    const payload = buildImportProgress({ uploads: null, pending: null, settled: null, oldest: null });
    expect(payload.available).toBe(false);
    expect(payload.stages.every((stage) => stage.pending === 0)).toBe(true);
  });
});
