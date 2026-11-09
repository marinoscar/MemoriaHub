// =============================================================================
// MemoriaHub's own `app.*` metrics (RETRO-T3, #628)
// =============================================================================
//
// The catalog of every metric MemoriaHub emits on top of the platform's
// (`app.jobs.*`, `app.nodes.*`, `app.ai.*`, ... are declared by the host slice
// and are NOT repeated here). Registered with the platform's, after them, by
// `platform/host-core.config.ts` (`registerPlatformHostAppMetrics(...,
// MEMORIAHUB_APP_METRICS)`), so the names exist before the first `add`.
//
// NAMES ARE PERMANENT: each one is a GreptimeDB table name (docs/specs/
// telemetry-metrics.md, "Table names"), and dashboards, saved explorer queries
// and alert rules name them. Rename nothing; add a new metric instead.
//
// LABELS. Only the attributes declared below, every one an `enum`: never an
// organization, user, circle, media, node or job id, a host name, a file name, a
// path, a URL or an error text. `MetricsHostService.add` drops an undeclared key
// and turns a value outside an enum into `other`, so a wrong call site cannot
// widen the cardinality. Worst case per metric is well under 7 x 5 x 4 series.
//
// Emitters inject `AppMetricsService` (`@marinoscar/platform-api/host`, global)
// with `@Optional()` and call `metrics?.add(key, n, attrs)` / `record(...)`:
// no `await`, never throws, a no-op while telemetry is off. Gauges are observed
// by the providers in `./gauges/`.
// =============================================================================

import type { AppMetricDef } from '@marinoscar/platform-api/otel-core';

declare module '@marinoscar/platform-api/otel-core' {
  interface AppMetricKeys {
    mediaUploads: true;
    mediaUploadSize: true;
    mediaProcessingDuration: true;
    mediaProcessingBacklog: true;
    mediaFacesDetected: true;
    peopleAssignments: true;
    mediaTagsApplied: true;
    mediaDuplicatesGrouped: true;
    mediaBurstsGrouped: true;
    mediaSocialClassified: true;
    mediaGeocoded: true;
    enrichmentPending: true;
    runsFinished: true;
    runItems: true;
    memoriesGenerated: true;
    memoriesDigestSent: true;
    storageBytes: true;
    storageTrashBytes: true;
    aiImagesGenerated: true;
    aiAudioSeconds: true;
    nodesCapability: true;
  }
}

/** An enum attribute: the only kind MemoriaHub declares (no free-form label). */
const oneOf = (...values: readonly string[]) => ({ kind: 'enum' as const, values });

// ---- Label vocabularies (shared by the catalog, the groups and the tests) ----

export const MEDIA_TYPES = ['photo', 'video'] as const;
/** `MediaItem.source` (the `MediaSource` enum). */
export const MEDIA_SOURCES = ['web', 'cli', 'android', 'import', 'sync'] as const;
export const UPLOAD_OUTCOMES = ['created', 'deduplicated', 'rejected'] as const;
export const PROCESSING_OUTCOMES = ['ready', 'failed'] as const;
export const BACKLOG_STATUSES = ['pending', 'uploading', 'processing'] as const;
export const EXECUTORS = ['server', 'node'] as const;
export const ASSIGNMENT_MODES = ['auto', 'manual', 'auto_archive'] as const;
export const TAG_SOURCES = ['ai', 'system', 'manual'] as const;
export const DUPLICATE_OUTCOMES = ['new_group', 'joined_group', 'evicted_by_burst'] as const;
export const BURST_OUTCOMES = ['new_group', 'joined_group'] as const;
export const SOCIAL_PLATFORMS = ['tiktok', 'instagram', 'facebook', 'other', 'clean'] as const;
export const SOCIAL_METHODS = ['metadata', 'filename', 'ocr', 'skip'] as const;
export const GEO_PROVIDERS = ['offline', 'nominatim', 'google'] as const;
export const GEOCODE_OUTCOMES = ['resolved', 'no_result', 'deferred', 'failed'] as const;
export const ENRICHMENT_STAGES = ['faces', 'tags', 'metadata', 'geocode', 'social'] as const;
export const RUN_ENGINES = ['workflow', 'review', 'trash_empty'] as const;
export const RUN_OUTCOMES = ['completed', 'completed_with_errors', 'failed', 'cancelled', 'expired'] as const;
export const RUN_ITEM_OUTCOMES = ['applied', 'skipped', 'failed'] as const;
export const MEMORY_TYPES = [
  'on_this_day',
  'trip',
  'person_highlights',
  'person_over_years',
  'theme',
  'seasonal',
  'year_in_review',
] as const;
export const TITLE_SOURCES = ['template', 'ai'] as const;
export const MEMORY_OUTCOMES = ['created', 'refreshed'] as const;
export const DIGEST_OUTCOMES = ['sent', 'skipped', 'failed'] as const;
export const STORAGE_PROVIDERS = ['s3', 'r2', 'local'] as const;
export const STORAGE_KINDS = ['photo', 'video', 'thumbnail', 'other'] as const;
export const IMAGE_QUALITIES = ['low', 'medium', 'high'] as const;
export const NODE_CAPABILITIES = ['ffmpeg', 'ffprobe', 'tesseract', 'clip', 'compreface'] as const;
export const CAPABILITY_STATES = ['ok', 'missing'] as const;

/** Media processing duration buckets, seconds (upload-complete to ready/failed). */
export const MEDIA_PROCESSING_BUCKETS = [1, 2, 5, 10, 30, 60, 120, 300, 600, 1800] as const;

/** Every `app.*` metric MemoriaHub declares, in catalog order. */
export const MEMORIAHUB_APP_METRICS: readonly AppMetricDef[] = [
  // ---- Media pipeline ---------------------------------------------------------
  {
    key: 'mediaUploads',
    name: 'app.media.uploads',
    kind: 'counter',
    unit: '{item}',
    description: 'Media registrations (POST /api/media), by media type, client source and outcome.',
    attributes: { media_type: oneOf(...MEDIA_TYPES), source: oneOf(...MEDIA_SOURCES), outcome: oneOf(...UPLOAD_OUTCOMES) },
  },
  {
    key: 'mediaUploadSize',
    name: 'app.media.upload.size',
    kind: 'counter',
    unit: 'By',
    description: 'Bytes of newly created media items (deduplicated uploads excluded), by media type and source.',
    attributes: { media_type: oneOf(...MEDIA_TYPES), source: oneOf(...MEDIA_SOURCES) },
  },
  {
    key: 'mediaProcessingDuration',
    name: 'app.media.processing.duration',
    kind: 'histogram',
    unit: 's',
    description: 'Time from upload complete to the stored object being ready or failed, by media type and outcome.',
    buckets: MEDIA_PROCESSING_BUCKETS,
    attributes: { media_type: oneOf(...MEDIA_TYPES), outcome: oneOf(...PROCESSING_OUTCOMES) },
  },
  {
    key: 'mediaProcessingBacklog',
    name: 'app.media.processing.backlog',
    kind: 'gauge',
    unit: '{object}',
    description: 'Stored objects not yet ready, by status.',
    attributes: { status: oneOf(...BACKLOG_STATUSES) },
  },
  // ---- Enrichment ------------------------------------------------------------
  {
    key: 'mediaFacesDetected',
    name: 'app.media.faces.detected',
    kind: 'counter',
    unit: '{face}',
    description: 'Faces persisted by face detection, by media type and the side that computed them.',
    attributes: { media_type: oneOf(...MEDIA_TYPES), executor: oneOf(...EXECUTORS) },
  },
  {
    key: 'peopleAssignments',
    name: 'app.people.assignments',
    kind: 'counter',
    unit: '{face}',
    description: 'Faces attached to a person or archived, by mode (automatic match, manual, auto-archive).',
    attributes: { mode: oneOf(...ASSIGNMENT_MODES) },
  },
  {
    key: 'mediaTagsApplied',
    name: 'app.media.tags.applied',
    kind: 'counter',
    unit: '{tag}',
    description: 'Tags attached to media items, by media type and source (AI, system, manual).',
    attributes: { media_type: oneOf(...MEDIA_TYPES), source: oneOf(...TAG_SOURCES) },
  },
  {
    key: 'mediaDuplicatesGrouped',
    name: 'app.media.duplicates.grouped',
    kind: 'counter',
    unit: '{item}',
    description: 'Items placed in (or evicted from) a near-duplicate group, by outcome.',
    attributes: { outcome: oneOf(...DUPLICATE_OUTCOMES) },
  },
  {
    key: 'mediaBurstsGrouped',
    name: 'app.media.bursts.grouped',
    kind: 'counter',
    unit: '{item}',
    description: 'Items placed in a burst group, by outcome.',
    attributes: { outcome: oneOf(...BURST_OUTCOMES) },
  },
  {
    key: 'mediaSocialClassified',
    name: 'app.media.social.classified',
    kind: 'counter',
    unit: '{item}',
    description: 'Videos classified by social-media detection, by platform (or clean) and method.',
    attributes: { platform: oneOf(...SOCIAL_PLATFORMS), method: oneOf(...SOCIAL_METHODS) },
  },
  {
    key: 'mediaGeocoded',
    name: 'app.media.geocoded',
    kind: 'counter',
    unit: '{item}',
    description: 'Reverse-geocode attempts, by provider and outcome.',
    attributes: { provider: oneOf(...GEO_PROVIDERS), outcome: oneOf(...GEOCODE_OUTCOMES) },
  },
  {
    key: 'enrichmentPending',
    name: 'app.enrichment.pending',
    kind: 'gauge',
    unit: '{item}',
    description: 'Media items pending or processing per enrichment stage (the per-item status tables).',
    attributes: { stage: oneOf(...ENRICHMENT_STAGES) },
  },
  // ---- Runs ------------------------------------------------------------------
  {
    key: 'runsFinished',
    name: 'app.runs.finished',
    kind: 'counter',
    unit: '{run}',
    description: 'Workflow, review and empty-trash runs reaching a terminal status, by engine and outcome.',
    attributes: { engine: oneOf(...RUN_ENGINES), outcome: oneOf(...RUN_OUTCOMES) },
  },
  {
    key: 'runItems',
    name: 'app.runs.items',
    kind: 'counter',
    unit: '{item}',
    description: 'Run items processed by the batch handlers, by engine and outcome.',
    attributes: { engine: oneOf(...RUN_ENGINES), outcome: oneOf(...RUN_ITEM_OUTCOMES) },
  },
  // ---- Memories --------------------------------------------------------------
  {
    key: 'memoriesGenerated',
    name: 'app.memories.generated',
    kind: 'counter',
    unit: '{memory}',
    description: 'Memories created or refreshed by generation, by type, title source and outcome.',
    attributes: { type: oneOf(...MEMORY_TYPES), title_source: oneOf(...TITLE_SOURCES), outcome: oneOf(...MEMORY_OUTCOMES) },
  },
  {
    key: 'memoriesDigestSent',
    name: 'app.memories.digest.sent',
    kind: 'counter',
    unit: '{email}',
    description: 'Memories digest emails, by outcome.',
    attributes: { outcome: oneOf(...DIGEST_OUTCOMES) },
  },
  // ---- Storage ---------------------------------------------------------------
  {
    key: 'storageBytes',
    name: 'app.storage.bytes',
    kind: 'gauge',
    unit: 'By',
    description: 'Stored bytes by provider and kind, from the latest storage insights snapshot.',
    attributes: { provider: oneOf(...STORAGE_PROVIDERS), kind: oneOf(...STORAGE_KINDS) },
  },
  {
    key: 'storageTrashBytes',
    name: 'app.storage.trash.bytes',
    kind: 'gauge',
    unit: 'By',
    description: 'Bytes held by trashed media items, from the latest storage insights snapshot.',
  },
  // ---- AI spend ----------------------------------------------------------------
  {
    key: 'aiImagesGenerated',
    name: 'app.ai.images.generated',
    kind: 'counter',
    unit: '{image}',
    description: 'AI-generated images (picture enhancement), by feature, quality and outcome.',
    attributes: { feature: oneOf('enhance'), quality: oneOf(...IMAGE_QUALITIES), outcome: oneOf(...PROCESSING_OUTCOMES) },
  },
  {
    key: 'aiAudioSeconds',
    name: 'app.ai.audio.transcribed',
    kind: 'counter',
    unit: 's',
    description: 'Seconds of audio sent for transcription, by feature.',
    attributes: { feature: oneOf('transcription') },
  },
  // ---- Fleet -----------------------------------------------------------------
  {
    key: 'nodesCapability',
    name: 'app.nodes.capability',
    kind: 'gauge',
    unit: '{node}',
    description: 'Online worker nodes reporting each compute capability as ok or missing.',
    attributes: { capability: oneOf(...NODE_CAPABILITIES), state: oneOf(...CAPABILITY_STATES) },
  },
];

// =============================================================================
// GreptimeDB table names
// =============================================================================
//
// The OTLP-to-table translation (docs/specs/telemetry-metrics.md, "Table
// names"): dots become `_`; a counter gets `_total`; a unit `s` / `By` adds
// `_seconds` / `_bytes` unless the name already carries that word; a histogram
// is `<name>_<unit>_bucket|_sum|_count`. The two `bytes` gauges below rely on the
// "already carries the word" rule (the Prometheus translator's); not verified
// live on GreptimeDB from this change. If the store spells them
// `app_storage_bytes_bytes` / `app_storage_trash_bytes_bytes`, change only these
// two constants: the families read the table name from here.
// =============================================================================

export const MH_TABLES = {
  mediaUploads: 'app_media_uploads_total',
  mediaUploadSize: 'app_media_upload_size_bytes_total',
  mediaProcessingDurationBucket: 'app_media_processing_duration_seconds_bucket',
  mediaProcessingBacklog: 'app_media_processing_backlog',
  mediaFacesDetected: 'app_media_faces_detected_total',
  peopleAssignments: 'app_people_assignments_total',
  mediaTagsApplied: 'app_media_tags_applied_total',
  mediaDuplicatesGrouped: 'app_media_duplicates_grouped_total',
  mediaBurstsGrouped: 'app_media_bursts_grouped_total',
  mediaSocialClassified: 'app_media_social_classified_total',
  mediaGeocoded: 'app_media_geocoded_total',
  enrichmentPending: 'app_enrichment_pending',
  runsFinished: 'app_runs_finished_total',
  runItems: 'app_runs_items_total',
  memoriesGenerated: 'app_memories_generated_total',
  memoriesDigestSent: 'app_memories_digest_sent_total',
  storageBytes: 'app_storage_bytes',
  storageTrashBytes: 'app_storage_trash_bytes',
  aiImagesGenerated: 'app_ai_images_generated_total',
  aiAudioSeconds: 'app_ai_audio_transcribed_seconds_total',
  nodesCapability: 'app_nodes_capability',
  // The platform's, read (never declared) by MemoriaHub's groups.
  jobsSettled: 'app_jobs_settled_total',
  jobsOldestPendingAge: 'app_jobs_oldest_pending_age_seconds',
  aiTokens: 'app_ai_tokens_total',
  nodesCount: 'app_nodes_count',
  // Declared by the platform once EAB#1083 ships (the node credential cache); referenced only.
  nodeCredentialsIssued: 'app_nodes_credentials_issued_total',
  nodeCredentialsCacheHits: 'app_nodes_credentials_cache_hits_total',
  nodeCredentialsCacheMisses: 'app_nodes_credentials_cache_misses_total',
  nodeCredentialsInvalidations: 'app_nodes_credentials_invalidations_total',
} as const;

// ---- Small typed helpers for the emit sites -----------------------------------

/** A `MediaItem.type` as the `media_type` label. */
export function mediaTypeLabel(type: unknown): (typeof MEDIA_TYPES)[number] | 'other' {
  return type === 'photo' || type === 'video' ? type : 'other';
}

/** A media mime type as the `media_type` label (video/* is video, every other is photo). */
export function mediaTypeFromMime(mime: string | null | undefined): (typeof MEDIA_TYPES)[number] {
  return typeof mime === 'string' && mime.startsWith('video/') ? 'video' : 'photo';
}

/** A count as a non-negative finite number (a BigInt byte count included); 0 otherwise. */
export function metricNumber(value: unknown): number {
  const n = typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
