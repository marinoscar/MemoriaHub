// =============================================================================
// MemoriaHub's metric catalog (RETRO-T3, #628)
// =============================================================================
//
// The 21 `app.*` metrics are permanent (each is a GreptimeDB table name) and
// carry no identifier: every attribute is an enum. This spec pins the names and
// kinds, proves the registry accepts the catalog after the platform's, and that
// `AppMetricsService.add` bounds a value outside an enum to `other`.
// =============================================================================

import { AppMetricsService, registerPlatformHostAppMetrics } from '@marinoscar/platform-api/host';
import { appMetricRegistry, MetricsHostService } from '@marinoscar/platform-api/otel-core';
import type { Meter } from '@opentelemetry/api';

import { MEMORIAHUB_APP_METRICS, MH_TABLES } from '../../src/platform-extensions/telemetry/memoriahub-metrics.manifest';

// The same registration `platform/host-core.config.ts` performs.
if (!appMetricRegistry.has('mediaUploads')) registerPlatformHostAppMetrics(MEMORIAHUB_APP_METRICS);

const EXPECTED: ReadonlyArray<[string, string, string]> = [
  ['mediaUploads', 'app.media.uploads', 'counter'],
  ['mediaUploadSize', 'app.media.upload.size', 'counter'],
  ['mediaProcessingDuration', 'app.media.processing.duration', 'histogram'],
  ['mediaProcessingBacklog', 'app.media.processing.backlog', 'gauge'],
  ['mediaFacesDetected', 'app.media.faces.detected', 'counter'],
  ['peopleAssignments', 'app.people.assignments', 'counter'],
  ['mediaTagsApplied', 'app.media.tags.applied', 'counter'],
  ['mediaDuplicatesGrouped', 'app.media.duplicates.grouped', 'counter'],
  ['mediaBurstsGrouped', 'app.media.bursts.grouped', 'counter'],
  ['mediaSocialClassified', 'app.media.social.classified', 'counter'],
  ['mediaGeocoded', 'app.media.geocoded', 'counter'],
  ['enrichmentPending', 'app.enrichment.pending', 'gauge'],
  ['runsFinished', 'app.runs.finished', 'counter'],
  ['runItems', 'app.runs.items', 'counter'],
  ['memoriesGenerated', 'app.memories.generated', 'counter'],
  ['memoriesDigestSent', 'app.memories.digest.sent', 'counter'],
  ['storageBytes', 'app.storage.bytes', 'gauge'],
  ['storageTrashBytes', 'app.storage.trash.bytes', 'gauge'],
  ['aiImagesGenerated', 'app.ai.images.generated', 'counter'],
  ['aiAudioSeconds', 'app.ai.audio.transcribed', 'counter'],
  ['nodesCapability', 'app.nodes.capability', 'gauge'],
];

/** Labels that would carry an identifier, a path or a message. */
const FORBIDDEN_LABEL = /(^|_)(id|ids|org|user|circle|node|host|hostname|path|url|file|filename|error|message|name)$/;

describe('MemoriaHub metric catalog', () => {
  it('declares exactly the 21 metrics of the issue, with permanent names and kinds', () => {
    expect(MEMORIAHUB_APP_METRICS.map((d) => [d.key, d.name, d.kind])).toEqual(EXPECTED);
  });

  it('registers every metric after the platform metrics', () => {
    const keys = appMetricRegistry.list().map((d) => d.key);
    expect(keys.indexOf('jobsSettled')).toBeGreaterThanOrEqual(0);
    for (const def of MEMORIAHUB_APP_METRICS) {
      expect(appMetricRegistry.require(def.key).name).toBe(def.name);
      expect(keys.indexOf(def.key)).toBeGreaterThan(keys.indexOf('jobsSettled'));
    }
  });

  it('declares only enum attributes, none of them an identifier', () => {
    for (const def of MEMORIAHUB_APP_METRICS) {
      for (const [key, attribute] of Object.entries(def.attributes ?? {})) {
        expect({ metric: def.key, key, kind: attribute.kind }).toEqual({ metric: def.key, key, kind: 'enum' });
        expect(key).not.toMatch(FORBIDDEN_LABEL);
        if (attribute.kind === 'enum') expect(attribute.values.length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every metric within the cardinality budget (7 x 5 x 4 series)', () => {
    let total = 0;
    for (const def of MEMORIAHUB_APP_METRICS) {
      const series = Object.values(def.attributes ?? {}).reduce(
        (n, attribute) => n * (attribute.kind === 'enum' ? attribute.values.length + 1 : Infinity),
        1,
      );
      expect({ metric: def.key, ok: series <= 7 * 5 * 4 * 2 }).toEqual({ metric: def.key, ok: true });
      total += series;
    }
    expect(total).toBeLessThan(2000);
  });

  it('names one table per metric, following the counter and unit suffix rules', () => {
    expect(MH_TABLES.mediaUploads).toBe('app_media_uploads_total');
    expect(MH_TABLES.mediaUploadSize).toBe('app_media_upload_size_bytes_total');
    expect(MH_TABLES.mediaProcessingDurationBucket).toBe('app_media_processing_duration_seconds_bucket');
    expect(MH_TABLES.aiAudioSeconds).toBe('app_ai_audio_transcribed_seconds_total');
    for (const def of MEMORIAHUB_APP_METRICS.filter((d) => d.kind === 'counter')) {
      expect(Object.values(MH_TABLES)).toContain(
        `${def.name.replace(/\./g, '_')}${def.unit === 'By' ? '_bytes' : def.unit === 's' ? '_seconds' : ''}_total`,
      );
    }
  });
});

describe('emitting through AppMetricsService', () => {
  /** A meter that records every add/record, so no SDK is needed. */
  function recordingMeter(points: Array<{ name: string; attributes: unknown; value: number }>): Meter {
    const instrument = (name: string) => ({
      add: (value: number, attributes?: unknown) => points.push({ name, attributes, value }),
      record: (value: number, attributes?: unknown) => points.push({ name, attributes, value }),
      addCallback: () => undefined,
      removeCallback: () => undefined,
    });
    return {
      createCounter: instrument,
      createHistogram: instrument,
      createUpDownCounter: instrument,
      createGauge: instrument,
      createObservableGauge: instrument,
      createObservableCounter: instrument,
      createObservableUpDownCounter: instrument,
      addBatchObservableCallback: () => undefined,
      removeBatchObservableCallback: () => undefined,
    } as unknown as Meter;
  }

  async function collect(emit: (metrics: AppMetricsService) => void) {
    const points: Array<{ name: string; attributes: unknown; value: number }> = [];
    const host = new MetricsHostService({ meter: recordingMeter(points), gauges: false, gateOpen: () => true });
    const metrics = new AppMetricsService(undefined, undefined, undefined, host);
    emit(metrics);
    return points.filter((p) => p.name.startsWith('app.media') || p.name.startsWith('app.runs'));
  }

  it('records a declared counter with its enum labels and drops undeclared ones', async () => {
    const points = await collect((m) =>
      m.add('mediaUploads', 2, { media_type: 'photo', source: 'web', outcome: 'created', userId: 'person-a' }),
    );
    expect(points).toEqual([
      { name: 'app.media.uploads', attributes: { media_type: 'photo', source: 'web', outcome: 'created' }, value: 2 },
    ]);
  });

  it('bounds a value outside an enum to "other"', async () => {
    const points = await collect((m) => m.add('runsFinished', 1, { engine: 'something-else', outcome: 'completed' }));
    expect(points[0]).toMatchObject({ attributes: { engine: 'other', outcome: 'completed' } });
  });

  it('records the processing histogram in seconds', async () => {
    const points = await collect((m) => m.record('mediaProcessingDuration', 12, { media_type: 'video', outcome: 'ready' }));
    expect(points[0]).toMatchObject({ name: 'app.media.processing.duration', attributes: { media_type: 'video', outcome: 'ready' } });
  });
});
