// ---------------------------------------------------------------------------
// Notification Center (epic #240) — client types.
//
// Mirrors the API's `notificationItemSchema` / `notificationListSchema`
// (apps/api/src/notifications/dto/notification-response.dto.ts). All date-ish
// fields are `string` because JSON transports ISO 8601.
// ---------------------------------------------------------------------------

/**
 * The producer that created a notification row.
 *
 * Kept as a closed union PLUS a `(string & {})` escape hatch so a row produced
 * by a newer API than this bundle still type-checks and renders with the
 * fallback icon rather than crashing the panel.
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
  | 'memories_ready';

/** One notification row. */
export interface NotificationItem {
  id: string;
  /**
   * Circle the notification belongs to, or `null` for a global (circle-less)
   * row such as `enrichment_failed` / `share_expiring`.
   *
   * When non-null, a client MUST switch the active circle to this id before
   * following `link` — the review-queue links are deliberately circle-agnostic
   * routes (`/bursts`, `/duplicates`, …) that render whatever circle is
   * currently active. See `NotificationPanel.handleOpen`.
   */
  circleId: string | null;
  type: NotificationType | (string & {});
  title: string;
  body: string | null;
  /** Same-origin app path to navigate to, or `null` for an informational row. */
  link: string | null;
  /** Free-form producer payload; `{ count, countAtRead? }` for review-queue rows. */
  data: unknown;
  readAt: string | null;
  dismissedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `status` filter accepted by `GET /api/notifications`. */
export type NotificationStatusFilter = 'unread' | 'read' | 'all' | 'dismissed';

export interface NotificationListParams {
  status?: NotificationStatusFilter;
  circleId?: string;
  page?: number;
  pageSize?: number;
}

export interface NotificationListMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

/**
 * Payload of `GET /api/notifications` AFTER the api client unwraps the global
 * TransformInterceptor's `{ data: … }` envelope — so pagination meta lives at
 * the top level here, not under a second `data`.
 */
export interface NotificationListResponse {
  items: NotificationItem[];
  meta: NotificationListMeta;
}

/** Payload of the two bulk endpoints. */
export interface NotificationBulkResult {
  updated: number;
}

// ---------------------------------------------------------------------------
// Per-type notification preferences (issue #251)
//
// Mirrors the API's `notificationPreferencesSchema` /
// `notificationPreferencesPatchSchema` (apps/api/src/common/schemas/
// settings.schema.ts). Lives inside `user_settings` — read/written ONLY through
// GET/PATCH/PUT /api/user-settings, there is no notifications-settings
// endpoint.
//
// ABSENT MEANS ENABLED. Every field is optional and the API never materializes
// one: an absent namespace, an absent `enabled`, or an absent per-type key all
// resolve to "on". That is what makes a NotificationType added in a later
// release opt-OUT rather than silently opt-in for anyone who ever saved a
// preference, so the client must never write a fully-populated object.
//
// ONE inversion: `workflowMicroRuns` absent means OFF (see #247).
// ---------------------------------------------------------------------------

/** The `notifications` namespace as stored and as returned by GET. */
export interface NotificationPreferences {
  /** Master switch. Absent === true. */
  enabled?: boolean;
  /** Per-type overrides. A type absent from this map is ENABLED. */
  types?: Partial<Record<NotificationType, boolean>>;
  /** Opt-in for `on_media_enriched` workflow micro-runs. Absent === false. */
  workflowMicroRuns?: boolean;
}

/**
 * The `notifications` namespace as accepted by PATCH.
 *
 * Identical to the stored shape except a per-type entry may be `null`, which
 * DELETES that key (JSON Merge Patch) and thereby resets the type to its
 * default rather than pinning it to `true`. That distinction is what keeps the
 * stored blob minimal: re-enabling a type removes the override instead of
 * accumulating one.
 */
export interface NotificationPreferencesPatch {
  enabled?: boolean;
  types?: Partial<Record<NotificationType, boolean | null>>;
  workflowMicroRuns?: boolean;
}
