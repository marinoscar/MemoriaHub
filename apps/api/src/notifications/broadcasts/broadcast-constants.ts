import { NotificationType, Prisma } from '@prisma/client';

// =============================================================================
// Admin notification broadcasts — shared constants (epic #481, issue #488)
// =============================================================================

/**
 * Job types. PERMANENT once rows exist (see the job handlers README): renaming
 * orphans every queued row, which for `broadcast_start` means a scheduled
 * announcement that silently never fires.
 */
export const BROADCAST_START_TYPE = 'broadcast_start';
export const BROADCAST_CHUNK_TYPE = 'broadcast_chunk';
export const BROADCAST_JOB_TYPES: ReadonlySet<string> = new Set([
  BROADCAST_START_TYPE,
  BROADCAST_CHUNK_TYPE,
]);

/** Users per chunk job. Also the worst-case duplicate bound on a crash retry. */
export const BROADCAST_CHUNK_SIZE = 200;

/** Recipients delivered concurrently inside a chunk. */
export const BROADCAST_SEND_CONCURRENCY = 5;

/**
 * Recipients between status re-checks (and cursor commits) inside a chunk: a
 * cancel stops the fan-out within this many further recipients, and a crash
 * re-sends at most this many.
 */
export const BROADCAST_STATUS_RECHECK_INTERVAL = 25;

/** Queue priority: user-facing, behind upload enrichment (5/10), ahead of backfills. */
export const BROADCAST_JOB_PRIORITY = 10;

export const BROADCAST_CHANNELS = ['inbox', 'push', 'email'] as const;
export type BroadcastChannel = (typeof BROADCAST_CHANNELS)[number];

export const BROADCAST_STATUSES = [
  'draft',
  'scheduled',
  'sending',
  'sent',
  'canceled',
  'failed',
] as const;

/** Payload every broadcast job carries (enrichment_jobs has no subject column). */
export interface BroadcastJobPayload {
  broadcastId: string;
}

/** Read the broadcast id off a job payload, or null for a malformed row. */
export function broadcastIdOf(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && 'broadcastId' in payload) {
    const id = (payload as { broadcastId: unknown }).broadcastId;
    return typeof id === 'string' && id.length > 0 ? id : null;
  }
  return null;
}

/** The notification type a broadcast is written under — DERIVED, never accepted. */
export function broadcastNotificationType(
  critical: boolean,
): Extract<NotificationType, 'admin_broadcast' | 'admin_broadcast_critical'> {
  return critical ? 'admin_broadcast_critical' : 'admin_broadcast';
}

/**
 * THE audience predicate: active users that existed at the cutoff. The
 * composer's count, the start handler's count and every chunk's page use this
 * one function, so the three numbers cannot disagree.
 */
export function audienceWhere(cutoff: Date): Prisma.UserWhereInput {
  return { isActive: true, createdAt: { lte: cutoff } };
}

/** Absolute CTA URL for email (mail clients cannot resolve `/path`). */
export function absoluteLink(appUrl: string | undefined, link: string | null | undefined): string | undefined {
  if (!link || !appUrl) return undefined;
  return `${appUrl.replace(/\/+$/, '')}${link}`;
}
