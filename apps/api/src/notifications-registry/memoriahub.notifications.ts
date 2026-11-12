// =============================================================================
// MemoriaHub's notification events on the platform slice (RETRO-D3, #576)
// =============================================================================
//
// The nine events MemoriaHub raises itself, declared for
// `@marinoscar/platform-api/notifications`: their keys, labels, channels and the
// browser renderer (bell row, OS toast and push text). The two broadcast types
// are the platform's own `admin.broadcast` / `admin.broadcast_critical`
// (`BROADCASTS_NOTIFICATIONS`), not redeclared here.
//
// -----------------------------------------------------------------------------
// THE EVENT KEYS ARE PERMANENT
// -----------------------------------------------------------------------------
// Once a preference, an inbox row or a delivery row names a key, renaming it
// would silently un-mute a user who muted the old key and orphan their history.
// Add a key; never rename or reuse one. `LEGACY_NOTIFICATION_TYPE_TO_EVENT_KEY`
// is the equally permanent map from the pre-platform `NotificationType` enum,
// used by the carry-over (`src/legacy/legacy-notifications-migration.ts`).
//
// -----------------------------------------------------------------------------
// FOLDING (STATE / COUNTED)
// -----------------------------------------------------------------------------
// `MEMORIAHUB_NOTIFICATION_FOLDS` is the single description of how each event
// folds into ONE inbox row (the volume guards of epic #240): the four review
// queues are STATE rows (one live row per user and circle, refreshed in place,
// dismissed when the queue drains), uploads, enrichment failures and memories
// are COUNTED rows (`data.count` grows), workflow runs and expiring shares are
// one row per occurrence. The carry-over computes each copied row's dedup key
// from it, and the producers pass the same scope and match to the platform's
// `notifyState` / `notifyCounted` once they exist (platform 0.1.0-next.26+).
//
// Renderers read `data` defensively: a row written before a field existed must
// still render. Every link is root-relative (the platform drops anything else).
// =============================================================================

import {
  ENRICHMENT_FAILED_EVENT_KEY,
  REVIEW_QUEUE_EVENT_KEYS,
  SHARE_EXPIRING_EVENT_KEY,
  UPLOAD_COMPLETED_EVENT_KEY,
  UPLOAD_COMPLETED_WINDOW_MS,
} from '@marinoscar/memoriahub-api/media';
import { MEMORIES_READY_EVENT_KEY, MEMORIES_READY_WINDOW_MS } from '@marinoscar/memoriahub-api/memories';
import { WORKFLOW_RUN_COMPLETED_EVENT_KEY } from '@marinoscar/memoriahub-api/workflows';
import { createHash } from 'node:crypto';

import type { NotificationType } from '@prisma/client';
import {
  BROADCAST_CRITICAL_EVENT_KEY,
  BROADCAST_EVENT_KEY,
  eventBrowserTemplateRegistry,
  type BrowserNotificationContent,
  type BrowserNotificationTemplate,
  type NotificationRegistration,
} from '@marinoscar/platform-api/notifications';

/** MemoriaHub's own event keys. PERMANENT: add, never rename. */
export const MEMORIAHUB_EVENT_KEYS = {
  // The four review-queue STATE events are the media slice's, which reconciles them.
  reviewBursts: REVIEW_QUEUE_EVENT_KEYS.bursts,
  reviewDuplicates: REVIEW_QUEUE_EVENT_KEYS.duplicates,
  reviewLocationSuggestions: REVIEW_QUEUE_EVENT_KEYS.locationSuggestions,
  reviewEnhancements: REVIEW_QUEUE_EVENT_KEYS.enhancements,
  uploadCompleted: UPLOAD_COMPLETED_EVENT_KEY,
  enrichmentFailed: ENRICHMENT_FAILED_EVENT_KEY,
  workflowRunCompleted: WORKFLOW_RUN_COMPLETED_EVENT_KEY,
  shareExpiring: SHARE_EXPIRING_EVENT_KEY,
  memoriesReady: MEMORIES_READY_EVENT_KEY,
} as const;

export type MemoriaHubEventKey = (typeof MEMORIAHUB_EVENT_KEYS)[keyof typeof MEMORIAHUB_EVENT_KEYS];

/**
 * The pre-platform `NotificationType` value to its platform event key.
 * PERMANENT, exhaustive over the enum (the compiler enforces it).
 */
export const LEGACY_NOTIFICATION_TYPE_TO_EVENT_KEY: Readonly<Record<NotificationType, string>> = {
  review_queue_bursts: MEMORIAHUB_EVENT_KEYS.reviewBursts,
  review_queue_duplicates: MEMORIAHUB_EVENT_KEYS.reviewDuplicates,
  review_queue_location_suggestions: MEMORIAHUB_EVENT_KEYS.reviewLocationSuggestions,
  review_queue_enhancements: MEMORIAHUB_EVENT_KEYS.reviewEnhancements,
  upload_completed: MEMORIAHUB_EVENT_KEYS.uploadCompleted,
  enrichment_failed: MEMORIAHUB_EVENT_KEYS.enrichmentFailed,
  workflow_run_completed: MEMORIAHUB_EVENT_KEYS.workflowRunCompleted,
  share_expiring: MEMORIAHUB_EVENT_KEYS.shareExpiring,
  memories_ready: MEMORIAHUB_EVENT_KEYS.memoriesReady,
  admin_broadcast: BROADCAST_EVENT_KEY,
  admin_broadcast_critical: BROADCAST_CRITICAL_EVENT_KEY,
};

/** How an event's inbox rows fold. */
export interface MemoriaHubFold {
  /** `state`: one live row per scope; `counted`: one growing row per scope and match; `event`: one row per call. */
  readonly kind: 'state' | 'counted' | 'event';
  /** `circle`: the row is scoped to its circle (`scope_id` = circle id); `none`: deployment-wide. */
  readonly scope: 'circle' | 'none';
  /** `data` fields that further partition a COUNTED row (sorted into the dedup key). */
  readonly matchKeys: readonly string[];
  /** A COUNTED row's rolling window, anchored on its last update; `null`: no window. */
  readonly windowMs: number | null;
}

/** The upload roll-up window (epic #240, issue #247): the media slice's, which raises the event. */
export { UPLOAD_COMPLETED_WINDOW_MS };
/** The memories roll-up window (epic #300, issue #311): the memories slice's, which raises the event. */
export { MEMORIES_READY_WINDOW_MS };

const STATE: MemoriaHubFold = { kind: 'state', scope: 'circle', matchKeys: [], windowMs: null };
const EVENT_IN_CIRCLE: MemoriaHubFold = { kind: 'event', scope: 'circle', matchKeys: [], windowMs: null };

export const MEMORIAHUB_NOTIFICATION_FOLDS: Readonly<Record<MemoriaHubEventKey, MemoriaHubFold>> = {
  'review.bursts': STATE,
  'review.duplicates': STATE,
  'review.location_suggestions': STATE,
  'review.enhancements': STATE,
  'media.upload_completed': { kind: 'counted', scope: 'circle', matchKeys: [], windowMs: UPLOAD_COMPLETED_WINDOW_MS },
  // No window: an unnoticed failure backlog keeps growing one row until an admin dismisses it.
  'media.enrichment_failed': { kind: 'counted', scope: 'none', matchKeys: ['jobType'], windowMs: null },
  'workflows.run_completed': EVENT_IN_CIRCLE,
  'shares.expiring': EVENT_IN_CIRCLE,
  'memories.ready': { kind: 'counted', scope: 'circle', matchKeys: [], windowMs: MEMORIES_READY_WINDOW_MS },
};

// ---------------------------------------------------------------------------
// Dedup keys
// ---------------------------------------------------------------------------
// PLATFORM-ADOPTION-SHIM(#576): byte-for-byte copies of `stateDedupKey` and
// `countedDedupKey` from the platform's `notification-inbox-writer.ts`, which
// `@marinoscar/platform-api/notifications` does not export (checked on
// 0.1.0-next.27). Only the carry-over uses them: it stamps copied live rows so
// the platform writer folds into the migrated rows. The unit test pins the
// format so a drift fails loudly; replace with the platform imports if a later
// version exports them (seam request: export the dedup-key builders).

const MAX_DEDUP_KEY_LENGTH = 200;

function capKey(key: string): string {
  if (key.length <= MAX_DEDUP_KEY_LENGTH) return key;
  return `${key.slice(0, 120)}#${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
}

/** The platform's STATE dedup key: one per `(eventKey, scopeId)`. */
export function stateDedupKey(eventKey: string, scopeId: string | null): string {
  return capKey(`state:${eventKey}:${scopeId ?? '-'}`);
}

/** The platform's COUNTED dedup key: one per `(eventKey, scopeId, match)`, match keys sorted. */
export function countedDedupKey(
  eventKey: string,
  scopeId: string | null,
  match: Readonly<Record<string, string | number | boolean>> | undefined,
): string {
  const entries = Object.entries(match ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const suffix = entries.length === 0 ? '' : `:${JSON.stringify(entries)}`;
  return capKey(`counted:${eventKey}:${scopeId ?? '-'}${suffix}`);
}

/**
 * The dedup key of an inbox row of a MemoriaHub event, or `null` for an
 * event that does not fold (or an unknown key).
 *
 * @param circleId - the row's circle (ignored for a deployment-wide event).
 * @param data - the row's payload; the fold's `matchKeys` are read from it.
 */
export function memoriahubDedupKey(eventKey: string, circleId: string | null, data: unknown): string | null {
  const fold = (MEMORIAHUB_NOTIFICATION_FOLDS as Record<string, MemoriaHubFold | undefined>)[eventKey];
  if (!fold || fold.kind === 'event') return null;
  const scopeId = fold.scope === 'circle' ? circleId : null;
  if (fold.kind === 'state') return stateDedupKey(eventKey, scopeId);
  const payload = isRecord(data) ? data : {};
  const match: Record<string, string | number | boolean> = {};
  for (const key of fold.matchKeys) {
    const value = payload[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') match[key] = value;
  }
  return countedDedupKey(eventKey, scopeId, match);
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(data: unknown, key: string): string | null {
  const value = isRecord(data) ? data[key] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(data: unknown, key: string): number | null {
  const value = isRecord(data) ? data[key] : undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** The platform types a template's data as `never`; ours read `unknown` defensively. */
function template(render: (data: unknown) => BrowserNotificationContent): BrowserNotificationTemplate {
  return render as BrowserNotificationTemplate;
}

const YOUR_CIRCLE = 'your circle';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A circle-agnostic route plus `?c=<circleId>`: the web shell switches the
 * active circle from it before the page renders (`useCircleLinkParam`), which
 * is how a notification about another circle opens in the right one.
 */
export function withCircle(path: string, circleId: unknown): string {
  if (typeof circleId !== 'string' || !UUID.test(circleId)) return path;
  return `${path}${path.includes('?') ? '&' : '?'}c=${circleId}`;
}

function reviewTemplate(noun: readonly [string, string], verb: string, link: string): BrowserNotificationTemplate {
  return template((data) => {
    const count = num(data, 'count') ?? 0;
    return {
      title: `${count} ${plural(count, noun[0], noun[1])} ${verb} in ${str(data, 'circleName') ?? YOUR_CIRCLE}`,
      body: '',
      link: withCircle(link, str(data, 'circleId')),
    };
  });
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `today` / `tomorrow` / `in N days`, bucketed on elapsed time (an expiry 3 hours out reads `today`). */
export function relativeExpiry(expiresAt: Date, now: Date): string {
  const ms = expiresAt.getTime() - now.getTime();
  if (ms < MS_PER_DAY) return 'today';
  const days = Math.floor(ms / MS_PER_DAY);
  return days === 1 ? 'tomorrow' : `in ${days} days`;
}

/** `workflows/runs/<id>` only for an id that is safe in a path segment. */
function workflowRunLink(runId: string | null): string {
  return runId && /^[A-Za-z0-9-]{1,64}$/.test(runId) ? `/workflows/runs/${runId}` : '/workflows';
}

const DECLARED: readonly NotificationRegistration[] = [
  {
    event: {
      key: MEMORIAHUB_EVENT_KEYS.reviewBursts,
      label: 'Burst review',
      description: 'Burst photo groups are waiting for you to pick the shots to keep.',
      channels: ['browser', 'push'],
      defaultEnabled: true,
    },
    browserTemplate: reviewTemplate(['burst group', 'burst groups'], 'ready to review', '/bursts'),
  },
  {
    event: {
      key: MEMORIAHUB_EVENT_KEYS.reviewDuplicates,
      label: 'Duplicate review',
      description: 'Near-duplicate photo groups are waiting for review.',
      channels: ['browser', 'push'],
      defaultEnabled: true,
    },
    browserTemplate: reviewTemplate(['duplicate group', 'duplicate groups'], 'ready to review', '/duplicates'),
  },
  {
    event: {
      key: MEMORIAHUB_EVENT_KEYS.reviewLocationSuggestions,
      label: 'Location suggestions',
      description: 'Inferred photo locations are waiting to be accepted or rejected.',
      channels: ['browser', 'push'],
      defaultEnabled: true,
    },
    browserTemplate: reviewTemplate(
      ['location suggestion', 'location suggestions'],
      'ready to review',
      '/location-suggestions',
    ),
  },
  {
    event: {
      key: MEMORIAHUB_EVENT_KEYS.reviewEnhancements,
      label: 'AI enhancements',
      description: 'AI-enhanced photos are waiting for you to keep, replace or discard them.',
      channels: ['browser', 'push'],
      defaultEnabled: true,
    },
    browserTemplate: reviewTemplate(['AI enhancement', 'AI enhancements'], 'awaiting review', '/enhancements'),
  },
  {
    event: {
      key: MEMORIAHUB_EVENT_KEYS.uploadCompleted,
      label: 'Upload complete',
      description: 'Photos and videos were added to one of your circles.',
      channels: ['browser', 'push'],
      defaultEnabled: true,
    },
    browserTemplate: template((data) => {
      const count = num(data, 'count') ?? 1;
      const circle = str(data, 'circleName') ?? YOUR_CIRCLE;
      const uploader = str(data, 'uploaderName');
      return {
        title: uploader
          ? `${uploader} added ${count} ${plural(count, 'photo', 'photos')} to ${circle}`
          : `${count} ${plural(count, 'item', 'items')} uploaded to ${circle}`,
        body: '',
        link: withCircle('/', str(data, 'circleId')),
      };
    }),
  },
  {
    event: {
      key: MEMORIAHUB_EVENT_KEYS.enrichmentFailed,
      label: 'Enrichment failed',
      description: 'Background enrichment jobs failed permanently (administrators).',
      channels: ['browser', 'push'],
      defaultEnabled: true,
    },
    browserTemplate: template((data) => {
      const count = num(data, 'count') ?? 1;
      const jobType = str(data, 'jobType') ?? 'enrichment';
      return {
        title: `${count} ${jobType} ${plural(count, 'job', 'jobs')} failed permanently`,
        body: str(data, 'lastError') ?? '',
        link: '/admin/settings/jobs?status=failed',
      };
    }),
  },
  {
    event: {
      key: MEMORIAHUB_EVENT_KEYS.workflowRunCompleted,
      label: 'Workflow run',
      description: 'A workflow you started or own finished running.',
      channels: ['browser', 'push'],
      defaultEnabled: true,
    },
    browserTemplate: template((data) => ({
      title:
        `Workflow '${str(data, 'workflowName') ?? 'workflow'}' finished: ` +
        `${num(data, 'succeededCount') ?? 0} applied, ${num(data, 'failedCount') ?? 0} failed`,
      body: '',
      link: workflowRunLink(str(data, 'runId')),
    })),
  },
  {
    event: {
      key: MEMORIAHUB_EVENT_KEYS.shareExpiring,
      label: 'Share expiring',
      description: 'A public share you created expires within a week.',
      channels: ['browser', 'push'],
      defaultEnabled: true,
    },
    browserTemplate: template((data) => {
      const expiresAt = str(data, 'notifiedFor');
      const when = expiresAt && !Number.isNaN(Date.parse(expiresAt)) ? relativeExpiry(new Date(expiresAt), new Date()) : 'soon';
      return {
        title: `A public share of '${str(data, 'targetName') ?? 'an item'}' expires ${when}`,
        body: '',
        link: '/admin/settings/sharing',
      };
    }),
  },
  {
    event: {
      key: MEMORIAHUB_EVENT_KEYS.memoriesReady,
      label: 'Memories ready',
      description: 'New memories were created in one of your circles.',
      channels: ['browser', 'push'],
      defaultEnabled: true,
    },
    browserTemplate: template((data) => {
      const count = num(data, 'count') ?? 1;
      return {
        title: `${count} new ${plural(count, 'memory', 'memories')} in ${str(data, 'circleName') ?? YOUR_CIRCLE}`,
        body: str(data, 'topTitle') ?? '',
        link: withCircle('/memories', str(data, 'circleId')),
      };
    }),
  },
];

/** The nine registrations, each event carrying the platform `kind` of its fold. */
export const MEMORIAHUB_NOTIFICATIONS: readonly NotificationRegistration[] = DECLARED.map((registration) => ({
  ...registration,
  event: {
    ...registration.event,
    kind: MEMORIAHUB_NOTIFICATION_FOLDS[registration.event.key as MemoriaHubEventKey].kind,
  },
}));

/**
 * Renders a registered event's browser template (bell row, toast and push
 * text) for `data`, or `null` when the event has none. For tests and the
 * producers' documentation; the platform dispatcher renders on its own.
 */
export function renderBrowserNotification(eventKey: string, data: unknown): BrowserNotificationContent | null {
  const binding = eventBrowserTemplateRegistry.get(eventKey);
  return binding ? (binding.render as unknown as (d: unknown) => BrowserNotificationContent)(data) : null;
}
