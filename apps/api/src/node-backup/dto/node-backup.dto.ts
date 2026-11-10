// =============================================================================
// Node Backup DTOs (issue #312, epic #308 — Local Media Backup via Worker Nodes)
// =============================================================================
//
// Request-body and query-param schemas for the node backup control plane
// (`/api/nodes/:id/backup/*`). Zod + createZodDto, matching the project
// convention — the global ZodValidationPipe validates bodies AND query DTOs.
//
// Serialization rule (see CLAUDE.md gotchas): every byte-count field crosses
// the wire as a STRING. `bytesDownloaded` is accepted as a decimal string
// (parsed with BigInt() server-side); a plain non-negative integer is also
// tolerated for robustness.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// PUT /nodes/:id/backup/config
// ---------------------------------------------------------------------------

export const updateBackupConfigSchema = z.object({
  enabled: z.boolean().optional(),
  /** 5-field cron expression; null clears the schedule (manual-trigger only). */
  scheduleCron: z.string().min(1).max(200).nullable().optional(),
  /** IANA timezone the cron is evaluated in; null clears (falls back to UTC). */
  timezone: z.string().min(1).max(100).nullable().optional(),
  /** Circle scope; empty array = ALL circles the node owner belongs to. */
  circleIds: z.array(z.string().uuid()).max(200).optional(),
});

export class UpdateBackupConfigDto extends createZodDto(updateBackupConfigSchema) {}

// ---------------------------------------------------------------------------
// POST /nodes/:id/backup/runs
// ---------------------------------------------------------------------------

export const startBackupRunSchema = z.object({
  kind: z.enum(['incremental', 'reconcile']),
  trigger: z.enum(['manual', 'scheduled']),
  cliVersion: z.string().min(1).max(64).optional(),
});

export class StartBackupRunDto extends createZodDto(startBackupRunSchema) {}

// ---------------------------------------------------------------------------
// Shared run stats (ack + finish finalStats)
// ---------------------------------------------------------------------------

export const backupRunStatsSchema = z.object({
  itemsDownloaded: z.number().int().min(0),
  itemsSkipped: z.number().int().min(0),
  sidecarsWritten: z.number().int().min(0),
  /** Bytes as a decimal STRING (BigInt-safe); a plain integer is tolerated. */
  bytesDownloaded: z.union([z.string().regex(/^\d+$/), z.number().int().min(0)]),
  errors: z.number().int().min(0),
});

export type BackupRunStats = z.infer<typeof backupRunStatsSchema>;

// ---------------------------------------------------------------------------
// POST /nodes/:id/backup/ack
// ---------------------------------------------------------------------------

export const backupAckSchema = z.object({
  runId: z.string().uuid(),
  cursor: z.object({
    updatedAt: z.iso.datetime({ offset: true }),
    id: z.string().uuid(),
  }),
  stats: backupRunStatsSchema,
});

export class BackupAckDto extends createZodDto(backupAckSchema) {}

// ---------------------------------------------------------------------------
// POST /nodes/:id/backup/runs/:runId/finish
// ---------------------------------------------------------------------------

export const finishBackupRunSchema = z.object({
  status: z.enum(['completed', 'failed', 'aborted']),
  error: z.string().min(1).max(4000).optional(),
  finalStats: backupRunStatsSchema.optional(),
});

export class FinishBackupRunDto extends createZodDto(finishBackupRunSchema) {}

// ---------------------------------------------------------------------------
// GET /nodes/:id/backup/changes
// ---------------------------------------------------------------------------

export const backupChangesQuerySchema = z.object({
  runId: z.string().uuid(),
  /** Keyset cursor half 1 — must be provided together with afterId. */
  updatedAfter: z.iso.datetime({ offset: true }).optional(),
  /** Keyset cursor half 2 — must be provided together with updatedAfter. */
  afterId: z.string().uuid().optional(),
  /** Page size; defaults to 100, clamped to backup.maxPageSize. */
  limit: z.coerce.number().int().min(1).optional(),
});

export class BackupChangesQueryDto extends createZodDto(backupChangesQuerySchema) {}

// ---------------------------------------------------------------------------
// GET /nodes/:id/backup/runs
// ---------------------------------------------------------------------------

export const backupRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export class BackupRunsQueryDto extends createZodDto(backupRunsQuerySchema) {}

// ---------------------------------------------------------------------------
// GET /nodes/:id/backup/manifest
// ---------------------------------------------------------------------------

export const backupManifestQuerySchema = z.object({
  runId: z.string().uuid(),
  afterId: z.string().uuid().optional(),
  /** Id-keyset page size; defaults to 1000, hard-capped at 1000. */
  limit: z.coerce.number().int().min(1).optional(),
});

export class BackupManifestQueryDto extends createZodDto(backupManifestQuerySchema) {}
