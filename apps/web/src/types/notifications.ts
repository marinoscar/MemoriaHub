// ---------------------------------------------------------------------------
// Notifications: client types (platform notifications slice since RETRO-D3, #576).
//
// The bell, the stream, Web Push and the preference matrix are
// `@marinoscar/platform-web/notifications`; this file keeps what the app's own
// inbox page (`/notifications`) and its icons need. The wire item is the
// platform's `AppNotification` (`eventKey`, `scopeId`, `count`, ...);
// `services/notifications.ts` maps it to `NotificationItem`.
// ---------------------------------------------------------------------------

export type {
  NotificationPreferences,
  NotificationPreferencesPatch,
} from '@marinoscar/platform-web/notifications/headless';

/**
 * The pre-platform notification type: still the key of the icon and label
 * table (`components/notifications/notificationMeta.tsx`). A `(string & {})`
 * escape hatch keeps an unknown event renderable with the fallback icon.
 */
export type NotificationType =
  | 'review_queue_bursts'
  | 'review_queue_duplicates'
  | 'review_queue_location_suggestions'
  | 'review_queue_enhancements'
  | 'upload_completed'
  | 'enrichment_failed'
  | 'workflow_run_completed'
  | 'share_expiring'
  | 'memories_ready'
  | 'admin_broadcast'
  | 'admin_broadcast_critical';

/**
 * The platform event key of each MemoriaHub notification (PERMANENT, the
 * API's `notifications-registry/memoriahub.notifications.ts`), mapped back to
 * the icon table's key.
 */
export const EVENT_KEY_TO_NOTIFICATION_TYPE: Readonly<Record<string, NotificationType>> = {
  'review.bursts': 'review_queue_bursts',
  'review.duplicates': 'review_queue_duplicates',
  'review.location_suggestions': 'review_queue_location_suggestions',
  'review.enhancements': 'review_queue_enhancements',
  'media.upload_completed': 'upload_completed',
  'media.enrichment_failed': 'enrichment_failed',
  'workflows.run_completed': 'workflow_run_completed',
  'shares.expiring': 'share_expiring',
  'memories.ready': 'memories_ready',
  'admin.broadcast': 'admin_broadcast',
  'admin.broadcast_critical': 'admin_broadcast_critical',
};

/** One inbox row, as the inbox page renders it. */
export interface NotificationItem {
  id: string;
  /** The platform event key (`review.duplicates`, `db_backup.backup_failed`, ...). */
  eventKey: string;
  /** The icon-table key: the MemoriaHub type, else the event key itself. */
  type: NotificationType | (string & {});
  /** The row's circle (the platform `scopeId`), or `null` for a deployment-wide row. */
  circleId: string | null;
  title: string;
  body: string | null;
  /** Same-origin app path (it carries `?c=<circleId>` for a circle's row), or `null`. */
  link: string | null;
  /** `{ count }` for a folded (STATE or COUNTED) row, else `null`. */
  data: { count: number } | null;
  readAt: string | null;
  dismissedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `status` filter accepted by `GET /api/notifications`. */
export type NotificationStatusFilter = 'unread' | 'read' | 'all' | 'dismissed';

export interface NotificationListParams {
  status?: NotificationStatusFilter;
  page?: number;
  pageSize?: number;
}

export interface NotificationListMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface NotificationListResponse {
  items: NotificationItem[];
  meta: NotificationListMeta;
}

/**
 * MemoriaHub's one notification preference without a platform equivalent
 * (the `memoriahubNotifications` user namespace): opt into the rolling
 * `on_media_enriched` workflow micro-run notifications. ABSENT MEANS FALSE.
 */
export interface MemoriaHubNotificationPreferences {
  workflowMicroRuns?: boolean;
}
