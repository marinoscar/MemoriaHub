// =============================================================================
// MemoriaHub's Telemetry Dashboard groups (RETRO-T3, #628)
// =============================================================================
//
// Six groups after the platform's (orders 10 to 60): media pipeline (80),
// enrichment (81), memories & people (82), storage (83), AI spend by feature
// (84) and the MemoriaHub view of the worker fleet (86). Each family reads one
// GreptimeDB table of `memoriahub-metrics.manifest.ts` (or a platform table it
// only READS: `app_jobs_settled_total`, `app_ai_tokens_total`, the node
// credential cache counters of EAB#1083). A family whose table or label is not
// in the store yet is skipped ("no data yet"), never an error: the AI spend
// group stays empty until RETRO-E2 adds the `feature` label to `app.ai.tokens`,
// and the credential-cache families until the platform ships them.
//
// IDS AND FAMILY KEYS ARE PERMANENT once dashboards and saved queries name them.
// Family keys carry an `mh` prefix: keys are unique across every group,
// platform ones included.
//
// KNOWN LIMIT. A table part filters with `=` / `<>` only, so the enrichment
// group's per-job-type table cannot be restricted to MemoriaHub's types (it
// lists every type, top 10 by failures). The verdict's failure rule IS
// restricted (`MEMORIAHUB_ENRICHMENT_JOB_TYPES`).
// =============================================================================

import {
  metricUnitRegistry,
  registerMetricUnit,
  type MetricGroupDef,
  type MetricUnitDef,
} from '@marinoscar/platform-api/telemetry';

import { MH_TABLES as T } from './memoriahub-metrics.manifest';

declare module '@marinoscar/platform-api/telemetry' {
  interface MetricGroupIds {
    /** Uploads, upload volume, processing time and backlog. */
    media: true;
    /** Enrichment stages: pending items, faces, tags, geocodes, social, duplicates, bursts, job failures. */
    enrichment: true;
    /** Memories generated, digest emails, people assignments. */
    memories: true;
    /** Stored bytes by provider and kind, trash bytes. */
    storage: true;
    /** AI tokens, images and audio by feature, with a USD estimate. */
    ai_spend: true;
    /** Worker fleet capabilities, node share of work, runs, credential cache. */
    fleet_mh: true;
  }
}

/** The API's `app_*` tables carry the service and the instance. */
const F = ['service', 'instance'] as const;

/** US dollars, to the cent (the AI spend estimate). */
export const USD_UNIT: MetricUnitDef = { id: 'usd', label: 'US dollars', format: 'currency', currency: 'USD', decimals: 2 };
/** Items per minute. */
export const ITEMS_PER_MIN_UNIT: MetricUnitDef = {
  id: 'items_per_min',
  label: 'Items per minute',
  format: 'number',
  decimals: 1,
  suffix: '/min',
};

/** Registers the two units once (a group that uses one must be registered after it). */
export function registerMemoriaHubMetricUnits(): void {
  for (const unit of [USD_UNIT, ITEMS_PER_MIN_UNIT]) {
    if (!metricUnitRegistry.has(unit.id)) registerMetricUnit(unit);
  }
}
registerMemoriaHubMetricUnits();

/**
 * A flat price per million AI tokens for the spend ESTIMATE, in US dollars.
 * Illustrative, like the platform's reference group: the tile is labelled an
 * estimate. A per-model price needs a `model` breakdown the dashboard's
 * families cannot multiply by.
 */
export const ESTIMATED_USD_PER_MILLION_TOKENS = 2;

const eq = (column: string, value: string) => ({ column, op: '=' as const, value });

// ---- media -------------------------------------------------------------------

export const MEDIA_METRIC_GROUP: MetricGroupDef = {
  id: 'media',
  label: 'Media pipeline',
  title: 'Media pipeline',
  order: 80,
  description: 'uploads per minute by source, upload volume, processing time p95, processing backlog, dedup rate',
  families: [
    { key: 'mhUploads', group: 'media', label: 'Uploads', table: T.mediaUploads, kind: 'counter', unit: 'items_per_min', rate: 'per_min', groupBy: 'source', requiredColumns: ['source'], filters: F },
    { key: 'mhUploadsByOutcome', group: 'media', label: 'Uploads by outcome', table: T.mediaUploads, kind: 'counter', unit: 'count', rate: 'count', groupBy: 'outcome', requiredColumns: ['outcome'], filters: F, tile: false },
    { key: 'mhUploadVolume', group: 'media', label: 'Upload volume per minute', table: T.mediaUploadSize, kind: 'counter', unit: 'bytes', rate: 'per_min', requiredColumns: [], filters: F },
    { key: 'mhProcessingP95', group: 'media', label: 'Processing time p95', table: T.mediaProcessingDurationBucket, kind: 'histogram', unit: 'seconds', quantile: 0.95, groupBy: 'media_type', requiredColumns: ['le', 'media_type'], filters: F },
    { key: 'mhProcessingBacklog', group: 'media', label: 'Processing backlog', table: T.mediaProcessingBacklog, kind: 'gauge', unit: 'count', groupBy: 'status', requiredColumns: ['status'], seriesAggregate: 'max', bucketAggregate: 'max', filters: F },
  ],
  ratios: [
    { key: 'mhDedupRate', group: 'media', label: 'Dedup rate', unit: '%', numerator: [{ family: 'mhUploadsByOutcome', groups: ['deduplicated'] }], denominator: [{ family: 'mhUploadsByOutcome', groups: ['created'] }], addNumerator: true, scale: 100 },
  ],
  tables: [
    {
      key: 'mhUploadsByType',
      group: 'media',
      label: 'Uploads by media type',
      keyColumn: 'media_type',
      keyLabel: 'Media type',
      filters: F,
      parts: (['created', 'deduplicated', 'rejected'] as const).map((outcome) => ({
        column: outcome,
        label: outcome[0].toUpperCase() + outcome.slice(1),
        unit: 'count',
        table: T.mediaUploads,
        requiredColumns: ['outcome'],
        where: [eq('outcome', outcome)],
        seriesAggregate: 'sum' as const,
        over: 'increase' as const,
      })),
    },
  ],
  presentation: {
    tiles: [
      { metric: 'mhUploads', label: 'Uploads/min' },
      { metric: 'mhUploadVolume', label: 'Upload volume/min' },
      { metric: 'mhProcessingP95', label: 'Processing p95' },
      { metric: 'mhProcessingBacklog', label: 'Backlog' },
      { metric: 'mhDedupRate' },
    ],
    series: [
      { title: 'Uploads per minute by source', metrics: ['mhUploads'], colors: { web: 'series-1', cli: 'series-2', android: 'series-3', import: 'series-4', sync: 'series-5' } },
      { title: 'Processing backlog', metrics: ['mhProcessingBacklog'], colors: { pending: 'info', uploading: 'neutral', processing: 'warn' } },
    ],
    tables: [{ metric: 'mhUploadsByType', sort: 'value-desc' }],
  },
};

// ---- enrichment ----------------------------------------------------------------

export const ENRICHMENT_METRIC_GROUP: MetricGroupDef = {
  id: 'enrichment',
  label: 'Enrichment',
  title: 'Enrichment',
  order: 81,
  description: 'items pending per stage, faces, tags, geocodes, social classification, duplicates and bursts per minute, job failures by type',
  families: [
    { key: 'mhEnrichmentPending', group: 'enrichment', label: 'Pending items', table: T.enrichmentPending, kind: 'gauge', unit: 'count', groupBy: 'stage', requiredColumns: ['stage'], seriesAggregate: 'max', bucketAggregate: 'max', filters: F },
    { key: 'mhFacesDetected', group: 'enrichment', label: 'Faces detected', table: T.mediaFacesDetected, kind: 'counter', unit: 'items_per_min', rate: 'per_min', groupBy: 'executor', requiredColumns: ['executor'], filters: F },
    { key: 'mhTagsApplied', group: 'enrichment', label: 'Tags applied', table: T.mediaTagsApplied, kind: 'counter', unit: 'items_per_min', rate: 'per_min', groupBy: 'source', requiredColumns: ['source'], filters: F },
    { key: 'mhGeocoded', group: 'enrichment', label: 'Geocoded', table: T.mediaGeocoded, kind: 'counter', unit: 'items_per_min', rate: 'per_min', groupBy: 'outcome', requiredColumns: ['outcome'], filters: F },
    { key: 'mhSocialClassified', group: 'enrichment', label: 'Social classification', table: T.mediaSocialClassified, kind: 'counter', unit: 'count', rate: 'count', groupBy: 'platform', requiredColumns: ['platform'], filters: F },
    { key: 'mhDuplicatesGrouped', group: 'enrichment', label: 'Duplicates grouped', table: T.mediaDuplicatesGrouped, kind: 'counter', unit: 'count', rate: 'count', groupBy: 'outcome', requiredColumns: ['outcome'], filters: F },
    { key: 'mhBurstsGrouped', group: 'enrichment', label: 'Bursts grouped', table: T.mediaBurstsGrouped, kind: 'counter', unit: 'count', rate: 'count', groupBy: 'outcome', requiredColumns: ['outcome'], filters: F },
    { key: 'mhJobsByExecutor', group: 'enrichment', label: 'Jobs succeeded by executor', table: T.jobsSettled, kind: 'counter', unit: 'count', rate: 'count', groupBy: 'executor', where: [eq('outcome', 'succeeded')], requiredColumns: ['executor', 'outcome'], filters: F, tile: false },
  ],
  ratios: [
    { key: 'mhNodeShare', group: 'enrichment', label: 'Node share of work', unit: '%', numerator: [{ family: 'mhJobsByExecutor', groups: ['node'] }], denominator: [{ family: 'mhJobsByExecutor', groups: ['server'] }], addNumerator: true, scale: 100 },
  ],
  tables: [
    {
      key: 'mhJobFailures',
      group: 'enrichment',
      label: 'Job failures by type',
      keyColumn: 'job_type',
      keyLabel: 'Job type',
      filters: F,
      parts: [
        { column: 'succeeded', label: 'Succeeded', unit: 'count', table: T.jobsSettled, requiredColumns: ['outcome'], where: [eq('outcome', 'succeeded')], seriesAggregate: 'sum', over: 'increase' },
        { column: 'failed', label: 'Failed', unit: 'count', table: T.jobsSettled, requiredColumns: ['outcome'], where: [eq('outcome', 'failed')], seriesAggregate: 'sum', over: 'increase' },
      ],
      derived: [{ column: 'failurePct', label: 'Failure %', unit: '%', numerator: 'failed', denominator: 'succeeded', scale: 100 }],
    },
  ],
  presentation: {
    tiles: [
      { metric: 'mhEnrichmentPending', label: 'Pending items' },
      { metric: 'mhFacesDetected', label: 'Faces/min' },
      { metric: 'mhTagsApplied', label: 'Tags/min' },
      { metric: 'mhGeocoded', label: 'Geocodes/min' },
      { metric: 'mhNodeShare' },
    ],
    series: [
      { title: 'Pending items by stage', metrics: ['mhEnrichmentPending'] },
      { title: 'Geocodes by outcome', metrics: ['mhGeocoded'], colors: { resolved: 'ok', no_result: 'neutral', deferred: 'warn', failed: 'crit' } },
      { title: 'Social classification by platform', metrics: ['mhSocialClassified'], colors: { clean: 'ok' } },
    ],
    tables: [{ metric: 'mhJobFailures', topN: 10, sort: 'problems-first' }],
  },
};

// ---- memories ----------------------------------------------------------------

export const MEMORIES_METRIC_GROUP: MetricGroupDef = {
  id: 'memories',
  label: 'Memories & people',
  title: 'Memories & people',
  order: 82,
  description: 'memories generated by type, digest emails by outcome, people assignments by mode, share of AI titles',
  families: [
    { key: 'mhMemoriesGenerated', group: 'memories', label: 'Memories generated', table: T.memoriesGenerated, kind: 'counter', unit: 'count', rate: 'count', groupBy: 'type', requiredColumns: ['type'], filters: F },
    { key: 'mhMemoriesByTitleSource', group: 'memories', label: 'Memories by title source', table: T.memoriesGenerated, kind: 'counter', unit: 'count', rate: 'count', groupBy: 'title_source', requiredColumns: ['title_source'], filters: F, tile: false },
    { key: 'mhDigestsSent', group: 'memories', label: 'Digest emails', table: T.memoriesDigestSent, kind: 'counter', unit: 'count', rate: 'count', groupBy: 'outcome', requiredColumns: ['outcome'], filters: F },
    { key: 'mhPeopleAssignments', group: 'memories', label: 'People assignments', table: T.peopleAssignments, kind: 'counter', unit: 'count', rate: 'count', groupBy: 'mode', requiredColumns: ['mode'], filters: F },
  ],
  ratios: [
    { key: 'mhAiTitles', group: 'memories', label: 'AI titles', unit: '%', numerator: [{ family: 'mhMemoriesByTitleSource', groups: ['ai'] }], denominator: [{ family: 'mhMemoriesByTitleSource', groups: ['template'] }], addNumerator: true, scale: 100 },
  ],
  presentation: {
    series: [
      { title: 'Digest emails by outcome', metrics: ['mhDigestsSent'], colors: { sent: 'ok', skipped: 'neutral', failed: 'crit' } },
      { title: 'People assignments by mode', metrics: ['mhPeopleAssignments'] },
    ],
  },
};

// ---- storage -----------------------------------------------------------------

export const STORAGE_METRIC_GROUP: MetricGroupDef = {
  id: 'storage',
  label: 'Storage',
  title: 'Storage',
  order: 83,
  description: 'stored bytes by kind and provider, trash bytes (from the storage insights snapshot)',
  families: [
    { key: 'mhStorageByKind', group: 'storage', label: 'Stored bytes by kind', table: T.storageBytes, kind: 'gauge', unit: 'bytes', groupBy: 'kind', requiredColumns: ['kind'], seriesAggregate: 'sum', bucketAggregate: 'max', filters: F },
    { key: 'mhStorageByProvider', group: 'storage', label: 'Stored bytes by provider', table: T.storageBytes, kind: 'gauge', unit: 'bytes', groupBy: 'provider', requiredColumns: ['provider'], seriesAggregate: 'sum', bucketAggregate: 'max', filters: F },
    { key: 'mhTrashBytes', group: 'storage', label: 'Trash', table: T.storageTrashBytes, kind: 'gauge', unit: 'bytes', requiredColumns: [], seriesAggregate: 'max', bucketAggregate: 'max', filters: F },
  ],
  tables: [
    {
      key: 'mhStorageKinds',
      group: 'storage',
      label: 'Bytes by kind',
      keyColumn: 'kind',
      keyLabel: 'Kind',
      filters: F,
      parts: [{ column: 'bytes', label: 'Bytes', unit: 'bytes', table: T.storageBytes, seriesAggregate: 'sum', over: 'last' }],
    },
  ],
  presentation: {
    tiles: [
      { metric: 'mhStorageByKind', label: 'Stored' },
      { metric: 'mhTrashBytes', label: 'Trash', color: 'warn' },
    ],
    tables: [{ metric: 'mhStorageKinds', sort: 'value-desc' }],
  },
};

// ---- ai_spend ------------------------------------------------------------------

export const AI_SPEND_METRIC_GROUP: MetricGroupDef = {
  id: 'ai_spend',
  label: 'AI spend by feature',
  title: 'AI spend by feature',
  order: 84,
  description: 'AI tokens by feature with a USD estimate, images generated, seconds of audio transcribed',
  families: [
    { key: 'mhAiTokensByFeature', group: 'ai_spend', label: 'AI tokens', table: T.aiTokens, kind: 'counter', unit: 'count', rate: 'count', groupBy: 'feature', requiredColumns: ['feature'], filters: F },
    { key: 'mhAiSpendByFeature', group: 'ai_spend', label: 'AI spend (estimate)', table: T.aiTokens, kind: 'counter', unit: 'usd', rate: 'count', scale: ESTIMATED_USD_PER_MILLION_TOKENS / 1_000_000, groupBy: 'feature', requiredColumns: ['feature'], filters: F },
    { key: 'mhAiImages', group: 'ai_spend', label: 'Images generated', table: T.aiImagesGenerated, kind: 'counter', unit: 'count', rate: 'count', groupBy: 'quality', requiredColumns: ['quality'], filters: F },
    { key: 'mhAiAudioSeconds', group: 'ai_spend', label: 'Audio transcribed', table: T.aiAudioSeconds, kind: 'counter', unit: 'seconds', rate: 'count', requiredColumns: [], filters: F },
  ],
  presentation: {
    tiles: [
      { metric: 'mhAiSpendByFeature', color: 'info' },
      { metric: 'mhAiTokensByFeature' },
      { metric: 'mhAiImages' },
      { metric: 'mhAiAudioSeconds' },
    ],
    series: [{ title: 'AI spend by feature (estimate)', metrics: ['mhAiSpendByFeature'] }],
  },
};

// ---- fleet_mh ------------------------------------------------------------------

const credentialFamily = (key: string, label: string, table: string, groupBy: 'purpose' | 'reason') => ({
  key,
  group: 'fleet_mh' as const,
  label,
  table,
  kind: 'counter' as const,
  unit: 'count',
  rate: 'count' as const,
  groupBy,
  requiredColumns: [groupBy],
  filters: F,
});

export const FLEET_MH_METRIC_GROUP: MetricGroupDef = {
  id: 'fleet_mh',
  label: 'Worker fleet (MemoriaHub)',
  title: 'Worker fleet (MemoriaHub)',
  order: 86,
  description: 'online nodes per compute capability, node share of work, runs finished by engine, node credential cache',
  families: [
    { key: 'mhCapabilityOk', group: 'fleet_mh', label: 'Nodes with capability', table: T.nodesCapability, kind: 'gauge', unit: 'count', groupBy: 'capability', where: [eq('state', 'ok')], requiredColumns: ['capability', 'state'], seriesAggregate: 'sum', bucketAggregate: 'max', filters: F },
    { key: 'mhFleetJobsByExecutor', group: 'fleet_mh', label: 'Jobs succeeded by executor', table: T.jobsSettled, kind: 'counter', unit: 'count', rate: 'count', groupBy: 'executor', where: [eq('outcome', 'succeeded')], requiredColumns: ['executor', 'outcome'], filters: F, tile: false },
    { key: 'mhRunsFinished', group: 'fleet_mh', label: 'Runs finished', table: T.runsFinished, kind: 'counter', unit: 'count', rate: 'count', groupBy: 'engine', requiredColumns: ['engine'], filters: F },
    { key: 'mhRunItems', group: 'fleet_mh', label: 'Run items', table: T.runItems, kind: 'counter', unit: 'count', rate: 'count', groupBy: 'outcome', requiredColumns: ['outcome'], filters: F },
    credentialFamily('mhCredentialsIssued', 'Credentials issued', T.nodeCredentialsIssued, 'purpose'),
    credentialFamily('mhCredentialCacheHits', 'Credential cache hits', T.nodeCredentialsCacheHits, 'purpose'),
    credentialFamily('mhCredentialCacheMisses', 'Credential cache misses', T.nodeCredentialsCacheMisses, 'purpose'),
    credentialFamily('mhCredentialInvalidations', 'Credential invalidations', T.nodeCredentialsInvalidations, 'reason'),
  ],
  ratios: [
    { key: 'mhFleetNodeShare', group: 'fleet_mh', label: 'Node share of work', unit: '%', numerator: [{ family: 'mhFleetJobsByExecutor', groups: ['node'] }], denominator: [{ family: 'mhFleetJobsByExecutor', groups: ['server'] }], addNumerator: true, scale: 100 },
    { key: 'mhCredentialHitRatio', group: 'fleet_mh', label: 'Credential cache hit ratio', unit: '%', numerator: [{ family: 'mhCredentialCacheHits' }], denominator: [{ family: 'mhCredentialCacheMisses' }], addNumerator: true, scale: 100 },
  ],
  tables: [
    {
      key: 'mhCapabilities',
      group: 'fleet_mh',
      label: 'Capabilities',
      keyColumn: 'capability',
      keyLabel: 'Capability',
      filters: F,
      parts: (['ok', 'missing'] as const).map((state) => ({
        column: state,
        label: state === 'ok' ? 'Nodes with it' : 'Nodes without it',
        unit: 'count',
        table: T.nodesCapability,
        requiredColumns: ['state'],
        where: [eq('state', state)],
        seriesAggregate: 'sum' as const,
        over: 'last' as const,
      })),
    },
  ],
  presentation: {
    tiles: [
      { metric: 'mhCapabilityOk', label: 'Capable nodes' },
      { metric: 'mhFleetNodeShare' },
      { metric: 'mhRunsFinished' },
      { metric: 'mhCredentialHitRatio' },
    ],
    series: [
      { title: 'Runs finished by engine', metrics: ['mhRunsFinished'] },
      { title: 'Credential issuance vs cache hits', metrics: ['mhCredentialsIssued', 'mhCredentialCacheHits'] },
      { title: 'Credential invalidations by reason', metrics: ['mhCredentialInvalidations'], colors: { auth_failure: 'crit' } },
    ],
    tables: [{ metric: 'mhCapabilities', sort: 'problems-first' }],
  },
};

/** MemoriaHub's six groups, in dashboard order. */
export const MEMORIAHUB_METRIC_GROUPS: readonly MetricGroupDef[] = [
  MEDIA_METRIC_GROUP,
  ENRICHMENT_METRIC_GROUP,
  MEMORIES_METRIC_GROUP,
  STORAGE_METRIC_GROUP,
  AI_SPEND_METRIC_GROUP,
  FLEET_MH_METRIC_GROUP,
];
