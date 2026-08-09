// =============================================================================
// Enrichment Job-Type Friendly Labels
// =============================================================================
//
// Single source of truth mapping an enrichment_jobs `type` to a human-readable
// display name for the admin Job Queue by-type stats (`/admin/settings/jobs`)
// and job insights. Surfaced as `label` on each `byType` stats entry.
//
// An unknown/new type falls back to a title-cased version of its snake_case
// identifier, so a handler added later still renders acceptably without a code
// change here.
// =============================================================================

export const JOB_TYPE_LABELS: Record<string, string> = {
  // Media enrichment (per-item compute)
  face_detection: 'Face detection',
  video_face_detection: 'Video face detection',
  auto_tagging: 'Auto-tagging',
  geocode: 'Geocoding',
  duplicate_detection: 'Duplicate detection',
  duplicate_detection_batch: 'Duplicate detection (batch)',
  duplicate_confidence_backfill: 'Duplicate confidence backfill',
  metadata_extraction: 'Metadata extraction',
  social_media_detection: 'Social media detection',
  location_inference: 'Location inference',
  // Deprecated aliases retained for one release so already-queued rows still
  // render a friendly label; superseded by review_run_* below (issue #190).
  location_suggestion_run_evaluate: 'Location suggestion run evaluate',
  location_suggestion_run_execute_batch: 'Location suggestion run execute batch',
  face_auto_archive_sweep: 'Face auto-archive sweep',
  burst_detection: 'Burst detection',
  picture_enhancement: 'AI picture enhancer',
  picture_enhancement_purge: 'AI picture enhancer purge',
  thumbnail_regen: 'Thumbnail regeneration',
  thumbnail_repair: 'Thumbnail repair',
  // Storage / system
  storage_insights: 'Storage insights',
  storage_migration: 'Storage migration',
  trash_purge: 'Trash purge',
  trash_empty_evaluate: 'Empty trash evaluate',
  trash_empty_execute_batch: 'Empty trash execute batch',
  job_history_purge: 'Job history purge',
  notification_purge: 'Notification purge',
  // Review-queue runs — bursts / duplicates / location suggestions (issue #190)
  review_run_evaluate: 'Review run evaluate',
  review_run_execute_batch: 'Review run execute batch',
  review_run_history_purge: 'Review run history purge',
  // Media Workflow Automation (issue #143)
  workflow_evaluate: 'Workflow evaluate',
  workflow_evaluate_item: 'Workflow evaluate (item)',
  workflow_execute_batch: 'Workflow execute batch',
  workflow_history_purge: 'Workflow history purge',
  // Memories (epic #300). `memory_digest` has no handler yet — its label is
  // declared here with `memory_generation` so #311 does not have to touch this
  // file again; an unlabeled type would only render title-cased anyway.
  memory_generation: 'Memory generation',
  memory_digest: 'Memory email digest',
};

/**
 * Friendly display label for an enrichment job type. Falls back to a title-cased
 * rendering of the snake_case type for any type not in the map.
 */
export function jobTypeLabel(type: string): string {
  const known = JOB_TYPE_LABELS[type];
  if (known) return known;
  return type
    .split('_')
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
