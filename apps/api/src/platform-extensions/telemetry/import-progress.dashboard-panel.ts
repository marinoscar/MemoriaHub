// =============================================================================
// The "Bulk import progress" dashboard panel (RETRO-T3, #628)
// =============================================================================
//
// A Telemetry Dashboard card answering "how far along is the import?": per
// enrichment stage, the items still pending against the uploads of the last
// 24 hours, the stage's throughput over the last hour and an ETA
// (pending / processed per minute), plus the platform's oldest pending age for
// the upload-time job types. The web half is
// `apps/web/src/platform-extensions/telemetry/ImportProgressPanelView.tsx`,
// registered under the same id.
//
// THE ID IS `memoriahub_import_progress`: the issue named
// `memoriahub.import_progress`, which the platform's panel id pattern
// (`^[a-z][a-z0-9_-]{1,47}$`) refuses.
//
// HOW IT READS. Only through `ctx.query`, the guarded facade (read-only, row cap,
// timeout, audit, at most 10 statements per request; this panel runs six). A
// counter's increase is summed per series with `lag()` (a drop is a reset), the
// series identity being every TAG column of the table, discovered from
// `information_schema`. A table that does not exist yet makes its part empty;
// the whole card says "no data yet" only when none of the tables exists.
// =============================================================================

import {
  TELEMETRY_ERROR_REASONS,
  TelemetryHttpError,
  type DashboardPanelContext,
  type DashboardPanelDef,
} from '@marinoscar/platform-api/telemetry';

import { ENRICHMENT_STAGES, MH_TABLES } from './memoriahub-metrics.manifest';

export const IMPORT_PROGRESS_PANEL_ID = 'memoriahub_import_progress';

/** The job types whose settled work drains each stage. */
export const STAGE_JOB_TYPES: Record<(typeof ENRICHMENT_STAGES)[number], readonly string[]> = {
  faces: ['face_detection', 'video_face_detection'],
  tags: ['auto_tagging', 'video_auto_tagging'],
  metadata: ['metadata_extraction'],
  geocode: ['geocode'],
  social: ['social_media_detection'],
};

/** The upload-time job types whose oldest pending age the card shows. */
export const IMPORT_JOB_TYPES = ['face_detection', 'auto_tagging', 'metadata_extraction', 'thumbnail_regen'] as const;

const UPLOAD_WINDOW_MS = 24 * 3_600_000;
const THROUGHPUT_WINDOW_MS = 3_600_000;

export interface ImportProgressStage {
  stage: string;
  /** Items pending or processing now (latest gauge reading). */
  pending: number;
  /** Uploads of the window that are no longer pending in this stage (never below 0). */
  done: number;
  /** Items this stage settled per minute over the last hour. */
  perMinute: number;
  /** pending / perMinute, or null while nothing is moving. */
  etaMinutes: number | null;
}

/** The panel's payload: what the web view receives. */
export interface ImportProgressPayload {
  /** At least one of the tables exists. `false` on a fresh stack. */
  available: boolean;
  /** Media items created in the last 24 hours (deduplicated uploads excluded). */
  uploads: number;
  windowHours: number;
  stages: ImportProgressStage[];
  /** Oldest pending age per upload-time job type, seconds (types with nothing pending absent). */
  oldestPending: Array<{ jobType: string; ageSeconds: number }>;
}

type Query = DashboardPanelContext['query'];

async function tagsOf(query: Query, table: string): Promise<string[]> {
  try {
    const described = await query.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = ${query.sql.literal(table)} AND semantic_type = 'TAG'`,
      { maxRows: 100 },
    );
    return described.rows.map((row) => String(row[0]));
  } catch (error) {
    // A store that is off or unreachable says so; anything else is "no data yet".
    if (error instanceof TelemetryHttpError && error.reason !== TELEMETRY_ERROR_REASONS.QUERY_FAILED) throw error;
    return [];
  }
}

function filterClauses(ctx: DashboardPanelContext, tags: readonly string[]): string[] {
  const { sql } = ctx.query;
  return [
    ...(ctx.filters.service && tags.includes('service_name')
      ? [`${sql.ident('service_name')} = ${sql.literal(ctx.filters.service)}`]
      : []),
    ...(ctx.filters.instance && tags.includes('app_instance_id')
      ? [`${sql.ident('app_instance_id')} = ${sql.literal(ctx.filters.instance)}`]
      : []),
  ];
}

/** Sum of a counter's increase between `from` and `to`, per `groupBy` value (or `''` for the total). */
async function counterIncrease(
  ctx: DashboardPanelContext,
  table: string,
  from: Date,
  to: Date,
  where: Record<string, string>,
  groupBy: string | null,
): Promise<Map<string, number> | null> {
  const { query } = ctx;
  const { sql } = query;
  const tags = await tagsOf(query, table);
  if (tags.length === 0) return null;
  if (groupBy && !tags.includes(groupBy)) return null;
  if (Object.keys(where).some((column) => !tags.includes(column))) return null;
  const clauses = [
    sql.between('greptime_timestamp', from, to),
    ...Object.entries(where).map(([column, value]) => `${sql.ident(column)} = ${sql.literal(value)}`),
    ...filterClauses(ctx, tags),
  ].join(' AND ');
  const key = groupBy ? sql.ident(groupBy) : `''`;
  const statement =
    `SELECT g, sum(CASE WHEN p IS NULL THEN 0 WHEN v >= p THEN v - p ELSE v END) AS inc ` +
    `FROM (SELECT ${key} AS g, ${sql.ident('greptime_value')} AS v, ` +
    `lag(${sql.ident('greptime_value')}) OVER (PARTITION BY ${tags.map(sql.ident).join(', ')} ORDER BY ${sql.ident('greptime_timestamp')}) AS p ` +
    `FROM ${sql.ident(table)} WHERE ${clauses}) GROUP BY g ${query.dialect.limit(200)}`;
  const result = await query.query(statement, { maxRows: 200 });
  const out = new Map<string, number>();
  for (const row of result.rows) {
    const value = Number(row[1]);
    if (Number.isFinite(value)) out.set(String(row[0]), value);
  }
  return out;
}

/** The latest value of a gauge per `groupBy` value, within the last few minutes before `to`. */
async function latestGauge(
  ctx: DashboardPanelContext,
  table: string,
  groupBy: string,
  to: Date,
  restrictTo?: readonly string[],
): Promise<Map<string, number> | null> {
  const { query } = ctx;
  const { sql } = query;
  const tags = await tagsOf(query, table);
  if (!tags.includes(groupBy)) return null;
  const from = new Date(to.getTime() - 10 * 60_000);
  const clauses = [
    sql.between('greptime_timestamp', from, to),
    ...(restrictTo && restrictTo.length > 0
      ? [`(${restrictTo.map((value) => `${sql.ident(groupBy)} = ${sql.literal(value)}`).join(' OR ')})`]
      : []),
    ...filterClauses(ctx, tags),
  ].join(' AND ');
  // Several API replicas report the same gauge: the maximum is the backlog.
  const statement =
    `SELECT ${sql.ident(groupBy)}, max(${sql.ident('greptime_value')}) FROM ${sql.ident(table)} ` +
    `WHERE ${clauses} GROUP BY ${sql.ident(groupBy)} ${query.dialect.limit(100)}`;
  const result = await query.query(statement, { maxRows: 100 });
  const out = new Map<string, number>();
  for (const row of result.rows) {
    const value = Number(row[1]);
    if (Number.isFinite(value)) out.set(String(row[0]), value);
  }
  return out;
}

/** Assembles the payload from what the reads returned. Pure (tested directly). */
export function buildImportProgress(input: {
  uploads: Map<string, number> | null;
  pending: Map<string, number> | null;
  settled: Map<string, number> | null;
  oldest: Map<string, number> | null;
}): ImportProgressPayload {
  const uploads = Math.round(input.uploads?.get('') ?? 0);
  const stages = ENRICHMENT_STAGES.map((stage) => {
    const pending = Math.round(input.pending?.get(stage) ?? 0);
    const settledLastHour = STAGE_JOB_TYPES[stage].reduce((sum, type) => sum + (input.settled?.get(type) ?? 0), 0);
    const perMinute = settledLastHour / (THROUGHPUT_WINDOW_MS / 60_000);
    return {
      stage,
      pending,
      done: Math.max(0, uploads - pending),
      perMinute: Math.round(perMinute * 100) / 100,
      etaMinutes: pending > 0 && perMinute > 0 ? Math.ceil(pending / perMinute) : pending === 0 ? 0 : null,
    };
  });
  const oldestPending = [...(input.oldest ?? new Map<string, number>()).entries()]
    .map(([jobType, ageSeconds]) => ({ jobType, ageSeconds: Math.round(ageSeconds) }))
    .sort((a, b) => b.ageSeconds - a.ageSeconds);
  return {
    available: [input.uploads, input.pending, input.settled, input.oldest].some((part) => part !== null),
    uploads,
    windowHours: UPLOAD_WINDOW_MS / 3_600_000,
    stages,
    oldestPending,
  };
}

/**
 * "Bulk import progress". Registered from `app-registrations/telemetry.ts`.
 */
export const IMPORT_PROGRESS_DASHBOARD_PANEL: DashboardPanelDef = {
  id: IMPORT_PROGRESS_PANEL_ID,
  label: 'Bulk import progress',
  // The platform's panels use 10 and 20; an app's go after.
  order: 90,
  async data(ctx): Promise<ImportProgressPayload> {
    const to = ctx.window.to;
    const uploads = await counterIncrease(ctx, MH_TABLES.mediaUploads, new Date(to.getTime() - UPLOAD_WINDOW_MS), to, { outcome: 'created' }, null);
    const pending = await latestGauge(ctx, MH_TABLES.enrichmentPending, 'stage', to);
    const settled = await counterIncrease(ctx, MH_TABLES.jobsSettled, new Date(to.getTime() - THROUGHPUT_WINDOW_MS), to, { outcome: 'succeeded' }, 'job_type');
    const oldest = await latestGauge(ctx, MH_TABLES.jobsOldestPendingAge, 'job_type', to, IMPORT_JOB_TYPES);
    return buildImportProgress({ uploads, pending, settled, oldest });
  },
};
