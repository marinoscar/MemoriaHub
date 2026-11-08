// =============================================================================
// Legacy notifications carry-over (RETRO-D3, #576)
// =============================================================================
//
// Moves MemoriaHub's pre-platform notification state onto the platform
// notifications slice. `scripts/migrate-notifications.ts` wires it to Postgres
// (`--dry-run` by default, `--apply`); the transforms here are pure or take the
// client as an argument, so they are unit-tested with fixtures and proven
// against real Postgres in `test/notifications/legacy-notifications-migration.db.spec.ts`.
//
// WHEN TO RUN: in the cutover window, AFTER the release that mounts the platform
// slice (platform >= 0.1.0-next.26, migration `0041_notifications_state_counted`)
// is deployed. `--apply` REFUSES while the platform inbox lacks the fold columns
// (`dismissed_at`, `data`, `updated_at`, `scope_id`, `dedup_key`): copying the
// inbox without them would resurface dismissed rows and drop every count, and
// rewriting the settings before the reader switches would break the running app.
// The dry run works on any schema and prints what an apply would do.
//
// STEPS (each idempotent, keyed on the legacy row id; the `mh_legacy_*` tables
// are only ever READ):
//   1. push_subscriptions  `mh_legacy_push_subscriptions` -> `push_subscriptions`
//      (same columns, `platform = 'browser'`). Same endpoints and the same VAPID
//      key (moved by `npm run credentials:migrate-legacy -- --purposes push_vapid`)
//      mean no browser re-subscribes.
//   2. broadcasts          `mh_legacy_notification_broadcasts` -> `notification_broadcasts`:
//      `critical` -> `event_key` (admin.broadcast[_critical]), channel `inbox` ->
//      `browser`, `recipient_count` -> `recipients_targeted`, `processed_count` ->
//      `recipients_dispatched`, `target_org_id` NULL (everyone). REFUSED while a
//      legacy broadcast is `scheduled` or `sending`: cancel it or let it finish.
//   3. inbox               `mh_legacy_notifications` -> `notifications`:
//      `type` -> `event_key` (LEGACY_NOTIFICATION_TYPE_TO_EVENT_KEY), `body` NULL ->
//      '', `circle_id` -> `scope_id`, `data` (with `count` / `countAtRead`),
//      `read_at`, `dismissed_at`, `created_at`, `updated_at` kept. A STATE or
//      COUNTED row gets the platform dedup key of its fold; of several LIVE rows
//      sharing a key (older upload windows) only the most recently updated keeps
//      it, the others are stored `retired:<id>` exactly as the platform retires a
//      closed window. A key a platform row already holds live wins: the legacy
//      row is retired.
//   4. deliveries          `mh_legacy_notification_deliveries` -> `notification_deliveries`
//      (`type` -> `event_key`, `recipient` = a fixed label: the legacy table kept none).
//   5. policy              `global.notifications` -> the platform shape:
//      `browserEnabled` kept, `pushEnabled` -> `channels.push.enabled`,
//      `disabledTypes` -> `disabledEvents` (mapped keys) plus `jobs.job_failed`
//      (Open decision 3: MemoriaHub's own `media.enrichment_failed` roll-up is the
//      one bell per failure), `retentionDays` / `purgeEnabled` ->
//      `retention.notifications` and `retention.notificationDeliveries` (only while
//      absent). The original is kept once under `mhLegacyNotifications` of the row.
//   6. preferences         each user's `notifications` -> channel-outer platform
//      preferences: an inbox-muted type (or `enabled: false`) is `browser` AND
//      `push` false for its event (the old inbox gate also gated push); a
//      push-muted type (or `push.enabled: false`) is `push` false. The mandatory
//      `admin_broadcast_critical` is skipped (the platform ignores it).
//      `workflowMicroRuns: true` -> the app namespace
//      `memoriahubNotifications.workflowMicroRuns`. The originals are kept once,
//      per user, in the `system_settings` row `mh_legacy_notification_preferences`
//      (user settings writes strip unknown keys, so they cannot live in the row).
//
// VAPID is not moved here: `credentials:migrate-legacy --purposes push_vapid`
// already plans it (RETRO-B4). The `webPush` row keeps `enabled`, `publicKey`
// and `subject` as they are: the platform reads the same row and ignores the
// legacy `privateKeyEncrypted` / `privateKeyLast4`, which stay for rollback.
// =============================================================================

import { NotificationType } from '@prisma/client';

import {
  LEGACY_NOTIFICATION_TYPE_TO_EVENT_KEY,
  memoriahubDedupKey,
} from '../notifications-registry/memoriahub.notifications';

/** The minimal client the carry-over needs (a `pg.Client` or `PoolClient`). */
export interface SqlClient {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}

type Json = Record<string, unknown>;

/** Key of the `global` settings document the original `notifications` value is kept under. */
export const LEGACY_NOTIFICATIONS_SETTINGS_KEY = 'mhLegacyNotifications';
/** `system_settings` row holding each user's original preferences, keyed by user id. */
export const LEGACY_PREFERENCES_ROW_KEY = 'mh_legacy_notification_preferences';
/** The app user namespace that carries `workflowMicroRuns` after the cutover. */
export const MEMORIAHUB_NOTIFICATIONS_USER_NAMESPACE = 'memoriahubNotifications';
/** The platform's "a job failed for good" event, suppressed in favour of the app roll-up. */
export const PLATFORM_JOB_FAILED_EVENT_KEY = 'jobs.job_failed';
/** The `recipient` label of a carried-over delivery row (the legacy table kept none). */
export const CARRIED_DELIVERY_RECIPIENT = 'carried over (pre-platform)';
/** Columns the platform inbox needs to hold MemoriaHub's rows (platform migration 0041). */
export const FOLD_COLUMNS = ['data', 'dismissed_at', 'updated_at', 'scope_id', 'dedup_key'] as const;

const MANDATORY_LEGACY_TYPES: ReadonlySet<string> = new Set([NotificationType.admin_broadcast_critical]);
const LEGACY_TYPES = Object.values(NotificationType) as string[];

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function eventKeyOf(type: string): string | null {
  return (LEGACY_NOTIFICATION_TYPE_TO_EVENT_KEY as Record<string, string | undefined>)[type] ?? null;
}

/** `CASE <column>::text WHEN 'legacy' THEN 'event.key' ... END`, from the permanent map. */
export function eventKeyCaseSql(column: string): string {
  const arms = Object.entries(LEGACY_NOTIFICATION_TYPE_TO_EVENT_KEY)
    .map(([type, key]) => `WHEN '${type}' THEN '${key}'`)
    .join(' ');
  return `CASE ${column}::text ${arms} ELSE 'unknown.' || ${column}::text END`;
}

// ---------------------------------------------------------------------------
// Pure transforms
// ---------------------------------------------------------------------------

export interface SettingsTransform {
  /** The value to store. */
  next: Json;
  /** One line per change. */
  changes: string[];
  /** Values that could not be kept exactly. */
  warnings: string[];
  /** Whether `next` differs from the input. */
  changed: boolean;
}

/** Whether a stored `notifications` system value is still MemoriaHub's shape. */
export function isLegacySystemPolicy(value: unknown): boolean {
  if (!isObject(value)) return false;
  return ['pushEnabled', 'disabledTypes', 'retentionDays', 'purgeEnabled'].some((k) => k in value);
}

function intInRange(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/**
 * Rewrites the `global` settings document's `notifications` (and `retention`)
 * into the platform's shape. Idempotent: a document already in the platform
 * shape comes back unchanged. The input is not mutated.
 */
export function transformSystemSettingsDocument(stored: unknown): SettingsTransform {
  const doc: Json = isObject(stored) ? structuredClone(stored) : {};
  const changes: string[] = [];
  const warnings: string[] = [];
  const legacy = doc.notifications;
  if (!isLegacySystemPolicy(legacy)) {
    return { next: doc, changes, warnings, changed: false };
  }
  const old = legacy as Json;

  const browserEnabled = typeof old.browserEnabled === 'boolean' ? old.browserEnabled : true;
  const pushEnabled = typeof old.pushEnabled === 'boolean' ? old.pushEnabled : true;
  const disabledEvents: string[] = [];
  for (const type of Array.isArray(old.disabledTypes) ? old.disabledTypes : []) {
    const key = typeof type === 'string' ? eventKeyOf(type) : null;
    if (!key) {
      warnings.push(`disabledTypes: unknown type ${JSON.stringify(type)} dropped`);
      continue;
    }
    if (MANDATORY_LEGACY_TYPES.has(type as string)) {
      warnings.push(`disabledTypes: ${type} is mandatory; mapped to ${key}, whose inbox row the platform still delivers`);
    }
    if (!disabledEvents.includes(key)) disabledEvents.push(key);
  }
  if (!disabledEvents.includes(PLATFORM_JOB_FAILED_EVENT_KEY)) {
    disabledEvents.push(PLATFORM_JOB_FAILED_EVENT_KEY);
    changes.push(`disabledEvents += ${PLATFORM_JOB_FAILED_EVENT_KEY} (media.enrichment_failed is the roll-up)`);
  }

  const next: Json = {
    browserEnabled,
    disabledEvents,
    channels: { browser: { enabled: browserEnabled }, push: { enabled: pushEnabled } },
  };
  changes.push(`browserEnabled ${browserEnabled}; pushEnabled -> channels.push.enabled ${pushEnabled}`);
  changes.push(`disabledTypes -> disabledEvents [${disabledEvents.join(', ')}]`);

  // Retention: the platform purges are the jobs slice's `retention.*` policies.
  const retention: Json = isObject(doc.retention) ? { ...doc.retention } : {};
  const days = intInRange(old.retentionDays, 1, 3650);
  const enabled = typeof old.purgeEnabled === 'boolean' ? old.purgeEnabled : true;
  let retentionChanged = false;
  for (const policy of ['notifications', 'notificationDeliveries'] as const) {
    if (isObject(retention[policy])) {
      changes.push(`retention.${policy} already stored: kept`);
      continue;
    }
    if (days === null) continue;
    retention[policy] = { enabled, days };
    retentionChanged = true;
    changes.push(`retentionDays/purgeEnabled -> retention.${policy} { enabled: ${enabled}, days: ${days} }`);
  }
  if (old.retentionDays !== undefined && days === null) {
    warnings.push(`retentionDays ${JSON.stringify(old.retentionDays)} is not a whole number of days: the platform default applies`);
  }
  warnings.push('the platform inbox purge deletes by age, read or not (MemoriaHub never deleted an unread row)');

  if (doc[LEGACY_NOTIFICATIONS_SETTINGS_KEY] === undefined) doc[LEGACY_NOTIFICATIONS_SETTINGS_KEY] = old;
  doc.notifications = next;
  if (retentionChanged) doc.retention = retention;
  return { next: doc, changes, warnings, changed: true };
}

/** Whether a user's stored `notifications` value is still MemoriaHub's shape. */
export function isLegacyUserPreferences(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (['enabled', 'types', 'workflowMicroRuns'].some((k) => k in value)) return true;
  return isObject(value.push) && ('enabled' in value.push || 'types' in value.push);
}

export interface UserPreferencesTransform {
  /** The platform `notifications` value, or `undefined` when nothing is muted. */
  notifications: Record<string, Record<string, boolean>> | undefined;
  /** `memoriahubNotifications`, or `undefined` when nothing is stored there. */
  memoriahub: { workflowMicroRuns: true } | undefined;
}

/** Translates one user's MemoriaHub preferences (absent means enabled). */
export function transformUserPreferences(legacy: unknown): UserPreferencesTransform {
  const prefs = isObject(legacy) ? legacy : {};
  const types = isObject(prefs.types) ? prefs.types : {};
  const push = isObject(prefs.push) ? prefs.push : {};
  const pushTypes = isObject(push.types) ? push.types : {};
  const allOff = prefs.enabled === false;
  const pushAllOff = push.enabled === false;

  const browser: Record<string, boolean> = {};
  const pushOut: Record<string, boolean> = {};
  for (const type of LEGACY_TYPES) {
    if (MANDATORY_LEGACY_TYPES.has(type)) continue;
    const key = eventKeyOf(type);
    if (!key) continue;
    const inboxOff = allOff || types[type] === false;
    if (inboxOff) {
      browser[key] = false;
      pushOut[key] = false;
    } else if (pushAllOff || pushTypes[type] === false) {
      pushOut[key] = false;
    }
  }
  const notifications: Record<string, Record<string, boolean>> = {};
  if (Object.keys(browser).length > 0) notifications.browser = browser;
  if (Object.keys(pushOut).length > 0) notifications.push = pushOut;
  return {
    notifications: Object.keys(notifications).length > 0 ? notifications : undefined,
    memoriahub: prefs.workflowMicroRuns === true ? { workflowMicroRuns: true } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Inbox planning (dedup keys)
// ---------------------------------------------------------------------------

/** One legacy inbox row, as read for the copy. */
export interface LegacyInboxRow {
  id: string;
  user_id: string;
  circle_id: string | null;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  data: unknown;
  read_at: Date | null;
  dismissed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** A platform inbox row to insert. */
export interface PlatformInboxRow {
  id: string;
  userId: string;
  eventKey: string;
  title: string;
  body: string;
  link: string | null;
  data: unknown;
  readAt: Date | null;
  dismissedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  scopeId: string | null;
  dedupKey: string | null;
}

/**
 * Maps legacy rows to platform rows and assigns dedup keys: at most one LIVE row
 * per (user, key) keeps the key, the most recently updated (ties: highest id);
 * every other live row with that key, and any whose key a platform row already
 * holds live (`takenLive`, entries `<userId>|<key>`), is `retired:<id>`.
 */
export function planInboxRows(rows: readonly LegacyInboxRow[], takenLive: ReadonlySet<string> = new Set()): PlatformInboxRow[] {
  const mapped: PlatformInboxRow[] = rows.map((row) => {
    const eventKey = eventKeyOf(row.type) ?? `unknown.${row.type}`;
    return {
      id: row.id,
      userId: row.user_id,
      eventKey,
      title: row.title,
      body: row.body ?? '',
      link: row.link,
      data: row.data ?? null,
      readAt: row.read_at,
      dismissedAt: row.dismissed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      scopeId: row.circle_id,
      dedupKey: memoriahubDedupKey(eventKey, row.circle_id, row.data),
    };
  });

  const winners = new Map<string, PlatformInboxRow>();
  for (const row of mapped) {
    if (row.dedupKey === null || row.dismissedAt !== null) continue;
    const slot = `${row.userId}|${row.dedupKey}`;
    const current = winners.get(slot);
    if (
      !current ||
      row.updatedAt.getTime() > current.updatedAt.getTime() ||
      (row.updatedAt.getTime() === current.updatedAt.getTime() && row.id > current.id)
    ) {
      winners.set(slot, row);
    }
  }
  for (const row of mapped) {
    if (row.dedupKey === null || row.dismissedAt !== null) continue;
    const slot = `${row.userId}|${row.dedupKey}`;
    if (winners.get(slot) !== row || takenLive.has(slot)) row.dedupKey = `retired:${row.id}`;
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// Against Postgres
// ---------------------------------------------------------------------------

/** Whether the platform `notifications` table has the fold columns (platform 0041). */
export async function platformInboxHasFoldColumns(client: SqlClient): Promise<boolean> {
  const res = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'notifications' AND column_name = ANY($1::text[])`,
    [[...FOLD_COLUMNS]],
  );
  return res.rows.length === FOLD_COLUMNS.length;
}

export interface TableCounts {
  legacy: number;
  alreadyCopied: number;
}

export interface CarryOverPlan {
  foldColumns: boolean;
  pushSubscriptions: TableCounts;
  broadcasts: TableCounts & { inFlight: Array<{ id: string; status: string }> };
  deliveries: TableCounts;
  inbox: TableCounts & {
    byType: Array<{ type: string; eventKey: string; total: number; live: number; unread: number }>;
  };
  system: SettingsTransform;
  users: { legacyShape: number; withMutes: number; withWorkflowMicroRuns: number };
}

async function counts(client: SqlClient, legacy: string, platform: string): Promise<TableCounts> {
  const res = await client.query<{ legacy: number; copied: number }>(
    `SELECT count(*)::int AS legacy,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ${platform} p WHERE p.id = l.id))::int AS copied
       FROM ${legacy} l`,
  );
  return { legacy: res.rows[0]?.legacy ?? 0, alreadyCopied: res.rows[0]?.copied ?? 0 };
}

async function readGlobal(client: SqlClient, lock: boolean): Promise<{ exists: boolean; doc: Json }> {
  const res = await client.query<{ value: unknown }>(
    `SELECT value FROM system_settings WHERE key = 'global'${lock ? ' FOR UPDATE' : ''}`,
  );
  return { exists: res.rows.length > 0, doc: isObject(res.rows[0]?.value) ? (res.rows[0]!.value as Json) : {} };
}

/** Reads only: what an apply would do. */
export async function planNotificationsCarryOver(client: SqlClient): Promise<CarryOverPlan> {
  const foldColumns = await platformInboxHasFoldColumns(client);
  const inFlight = (
    await client.query<{ id: string; status: string }>(
      `SELECT id::text AS id, status::text AS status FROM mh_legacy_notification_broadcasts
        WHERE status::text IN ('scheduled', 'sending') ORDER BY created_at`,
    )
  ).rows;
  const byType = (
    await client.query<{ type: string; total: number; live: number; unread: number }>(
      `SELECT type::text AS type, count(*)::int AS total,
              count(*) FILTER (WHERE dismissed_at IS NULL)::int AS live,
              count(*) FILTER (WHERE dismissed_at IS NULL AND read_at IS NULL)::int AS unread
         FROM mh_legacy_notifications GROUP BY type ORDER BY type`,
    )
  ).rows.map((r) => ({ ...r, eventKey: eventKeyOf(r.type) ?? `unknown.${r.type}` }));

  const users = (
    await client.query<{ value: unknown }>(`SELECT value->'notifications' AS value FROM user_settings WHERE value ? 'notifications'`)
  ).rows;
  let legacyShape = 0;
  let withMutes = 0;
  let withWorkflowMicroRuns = 0;
  for (const { value } of users) {
    if (!isLegacyUserPreferences(value)) continue;
    legacyShape += 1;
    const t = transformUserPreferences(value);
    if (t.notifications) withMutes += 1;
    if (t.memoriahub) withWorkflowMicroRuns += 1;
  }

  return {
    foldColumns,
    pushSubscriptions: await counts(client, 'mh_legacy_push_subscriptions', 'push_subscriptions'),
    broadcasts: { ...(await counts(client, 'mh_legacy_notification_broadcasts', 'notification_broadcasts')), inFlight },
    deliveries: await counts(client, 'mh_legacy_notification_deliveries', 'notification_deliveries'),
    inbox: { ...(await counts(client, 'mh_legacy_notifications', 'notifications')), byType },
    system: transformSystemSettingsDocument((await readGlobal(client, false)).doc),
    users: { legacyShape, withMutes, withWorkflowMicroRuns },
  };
}

export interface CarryOverResult {
  pushSubscriptions: number;
  broadcasts: number;
  inbox: number;
  inboxRetiredKeys: number;
  deliveries: number;
  systemSettingsWritten: boolean;
  usersRewritten: number;
}

const COPY_PUSH_SUBSCRIPTIONS_SQL = `
INSERT INTO push_subscriptions (
  id, user_id, endpoint, p256dh, auth, expiration_time, user_agent,
  failure_count, last_success_at, platform, created_at, updated_at)
SELECT l.id, l.user_id, l.endpoint, l.p256dh, l.auth, l.expiration_time, l.user_agent,
       l.failure_count, l.last_success_at, 'browser', l.created_at, l.updated_at
  FROM mh_legacy_push_subscriptions l
  JOIN users u ON u.id = l.user_id
ON CONFLICT DO NOTHING`;

const COPY_BROADCASTS_SQL = `
INSERT INTO notification_broadcasts (
  id, title, body, link, cta_label, event_key, channels, status, scheduled_for,
  started_at, finished_at, canceled_at, audience_cutoff, cursor_user_id,
  recipients_targeted, recipients_dispatched, last_error, created_by_id,
  created_at, updated_at, target_org_id)
SELECT l.id, l.title, l.body, l.link, l.cta_label,
       CASE WHEN l.critical THEN 'admin.broadcast_critical' ELSE 'admin.broadcast' END,
       ARRAY(SELECT CASE c WHEN 'inbox' THEN 'browser' ELSE c END FROM unnest(l.channels) AS c),
       l.status::text::"NotificationBroadcastStatus", l.scheduled_for,
       l.started_at, l.finished_at, l.canceled_at, l.audience_cutoff, l.cursor_user_id,
       l.recipient_count, l.processed_count, l.last_error,
       (SELECT u.id FROM users u WHERE u.id = l.created_by_id),
       l.created_at, l.updated_at, NULL
  FROM mh_legacy_notification_broadcasts l
ON CONFLICT (id) DO NOTHING`;

function copyDeliveriesSql(): string {
  return `
INSERT INTO notification_deliveries (
  id, event_key, user_id, recipient, channel, status, provider_message_id, error, created_at, updated_at)
SELECT l.id, ${eventKeyCaseSql('l.type')}, (SELECT u.id FROM users u WHERE u.id = l.user_id),
       $1, l.channel, l.status::text::"NotificationDeliveryStatus", l.provider_message_id, l.error,
       l.created_at, l.updated_at
  FROM mh_legacy_notification_deliveries l
ON CONFLICT (id) DO NOTHING`;
}

const INBOX_BATCH = 500;

async function copyInbox(client: SqlClient): Promise<{ inserted: number; retired: number }> {
  const taken = new Set(
    (
      await client.query<{ slot: string }>(
        `SELECT user_id::text || '|' || dedup_key AS slot FROM notifications
          WHERE dismissed_at IS NULL AND dedup_key IS NOT NULL AND dedup_key NOT LIKE 'retired:%'
            AND NOT EXISTS (SELECT 1 FROM mh_legacy_notifications l WHERE l.id = notifications.id)`,
      )
    ).rows.map((r) => r.slot),
  );
  // The winner of a key must be chosen over ALL of a user's legacy rows, so the
  // rows are read whole (MemoriaHub's inbox is bounded by its volume guards).
  const rows = (
    await client.query<LegacyInboxRow>(
      `SELECT id::text AS id, user_id::text AS user_id, circle_id::text AS circle_id, type::text AS type,
              title, body, link, data, read_at, dismissed_at, created_at, updated_at
         FROM mh_legacy_notifications l
        WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = l.user_id)
        ORDER BY id`,
    )
  ).rows;
  const planned = planInboxRows(rows, taken);
  let inserted = 0;
  for (let i = 0; i < planned.length; i += INBOX_BATCH) {
    const batch = planned.slice(i, i + INBOX_BATCH);
    const values: unknown[] = [];
    const tuples = batch.map((r, n) => {
      const b = n * 13;
      values.push(
        r.id, r.userId, r.eventKey, r.title, r.body, r.link,
        r.data === null || r.data === undefined ? null : JSON.stringify(r.data),
        r.readAt, r.dismissedAt, r.createdAt, r.updatedAt, r.scopeId, r.dedupKey,
      );
      return `($${b + 1}::uuid, $${b + 2}::uuid, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}::jsonb, $${b + 8}::timestamptz, $${b + 9}::timestamptz, $${b + 10}::timestamptz, $${b + 11}::timestamptz, $${b + 12}::uuid, $${b + 13})`;
    });
    const res = await client.query(
      `INSERT INTO notifications (id, user_id, event_key, title, body, link, data, read_at, dismissed_at, created_at, updated_at, scope_id, dedup_key)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (id) DO NOTHING`,
      values,
    );
    inserted += res.rowCount ?? 0;
  }
  const retired = planned.filter((r) => r.dedupKey?.startsWith('retired:')).length;
  return { inserted, retired };
}

async function rewriteSystemSettings(client: SqlClient): Promise<boolean> {
  const { exists, doc } = await readGlobal(client, true);
  const transform = transformSystemSettingsDocument(doc);
  if (!exists || !transform.changed) return false;
  await client.query(
    `UPDATE system_settings SET value = $1::jsonb, version = version + 1, updated_at = now() WHERE key = 'global'`,
    [JSON.stringify(transform.next)],
  );
  return true;
}

async function rewriteUserPreferences(client: SqlClient): Promise<number> {
  const rows = (
    await client.query<{ user_id: string; value: unknown }>(
      `SELECT user_id::text AS user_id, value FROM user_settings WHERE value ? 'notifications' FOR UPDATE`,
    )
  ).rows.filter((r) => isObject(r.value) && isLegacyUserPreferences((r.value as Json).notifications));
  if (rows.length === 0) return 0;

  // Keep each original once (set-if-absent) before rewriting it.
  const backup = await client.query<{ value: unknown }>(
    `SELECT value FROM system_settings WHERE key = $1 FOR UPDATE`,
    [LEGACY_PREFERENCES_ROW_KEY],
  );
  const kept: Json = isObject(backup.rows[0]?.value) ? { ...(backup.rows[0]!.value as Json) } : {};
  for (const row of rows) {
    if (kept[row.user_id] === undefined) kept[row.user_id] = (row.value as Json).notifications;
  }
  await client.query(
    `INSERT INTO system_settings (id, key, value, version, updated_at)
     VALUES (gen_random_uuid(), $1, $2::jsonb, 1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = system_settings.version + 1, updated_at = now()`,
    [LEGACY_PREFERENCES_ROW_KEY, JSON.stringify(kept)],
  );

  for (const row of rows) {
    const value: Json = { ...(row.value as Json) };
    const t = transformUserPreferences(value.notifications);
    if (t.notifications) value.notifications = t.notifications;
    else delete value.notifications;
    if (t.memoriahub) {
      const existing = isObject(value[MEMORIAHUB_NOTIFICATIONS_USER_NAMESPACE]) ? (value[MEMORIAHUB_NOTIFICATIONS_USER_NAMESPACE] as Json) : {};
      value[MEMORIAHUB_NOTIFICATIONS_USER_NAMESPACE] = { ...existing, ...t.memoriahub };
    }
    await client.query(
      `UPDATE user_settings SET value = $2::jsonb, version = version + 1, updated_at = now() WHERE user_id = $1::uuid`,
      [row.user_id, JSON.stringify(value)],
    );
  }
  return rows.length;
}

/**
 * Applies every step in ONE transaction (all or nothing).
 *
 * @throws Error when the platform inbox lacks the fold columns (the cutover
 *   release is not deployed) or a legacy broadcast is still scheduled or sending.
 */
export async function applyNotificationsCarryOver(client: SqlClient): Promise<CarryOverResult> {
  if (!(await platformInboxHasFoldColumns(client))) {
    throw new Error(
      `The platform notifications table has no ${FOLD_COLUMNS.join('/')} columns (platform migration ` +
        '0041_notifications_state_counted, 0.1.0-next.26+). Deploy the release that mounts the platform ' +
        'notifications slice first; the dry run works meanwhile.',
    );
  }
  const plan = await planNotificationsCarryOver(client);
  if (plan.broadcasts.inFlight.length > 0) {
    throw new Error(
      `Legacy broadcasts are still scheduled or sending (${plan.broadcasts.inFlight
        .map((b) => `${b.id}:${b.status}`)
        .join(', ')}); cancel them or let them finish first.`,
    );
  }
  await client.query('BEGIN');
  try {
    const pushSubscriptions = (await client.query(COPY_PUSH_SUBSCRIPTIONS_SQL)).rowCount ?? 0;
    const broadcasts = (await client.query(COPY_BROADCASTS_SQL)).rowCount ?? 0;
    const inbox = await copyInbox(client);
    const deliveries = (await client.query(copyDeliveriesSql(), [CARRIED_DELIVERY_RECIPIENT])).rowCount ?? 0;
    const systemSettingsWritten = await rewriteSystemSettings(client);
    const usersRewritten = await rewriteUserPreferences(client);
    await client.query('COMMIT');
    return {
      pushSubscriptions,
      broadcasts,
      inbox: inbox.inserted,
      inboxRetiredKeys: inbox.retired,
      deliveries,
      systemSettingsWritten,
      usersRewritten,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

