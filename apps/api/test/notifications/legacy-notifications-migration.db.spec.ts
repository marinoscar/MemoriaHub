/**
 * Real-Postgres tier (RETRO-D3, #576): runs the notifications carry-over
 * (`src/legacy/legacy-notifications-migration.ts`) against copies of the real
 * tables and proves the runbook's claims:
 *
 *   - `--apply` refuses while the platform inbox lacks the 0041 fold columns,
 *     writing nothing;
 *   - with them, every legacy row arrives under its id: the inbox with its
 *     event key, count, `countAtRead`, read and dismissed state, one live dedup
 *     key per (user, scope) and older live windows retired, so the platform's
 *     partial unique index accepts the copy; push subscriptions with their
 *     endpoint and failure count; broadcasts and deliveries mapped;
 *   - the policy and the preferences are rewritten, originals kept;
 *   - a second apply changes nothing, and the legacy tables are untouched;
 *   - in-flight broadcasts block the apply.
 *
 * The spec builds throw-away copies of the tables in a scratch schema (the
 * enum types come from `public`), so it runs on a fully migrated database on
 * platform 0.1.0-next.22: it adds platform migration 0041's columns and index
 * to its own copy of `notifications`. When no migrated database is reachable,
 * the suite skips (logged).
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

import {
  CARRIED_DELIVERY_RECIPIENT,
  LEGACY_PREFERENCES_ROW_KEY,
  applyNotificationsCarryOver,
  planNotificationsCarryOver,
} from '../../src/legacy/legacy-notifications-migration';
import { orgScoped } from '../helpers/org-scope';

type Row = Record<string, unknown>;

const USER_A = randomUUID();
const USER_B = randomUUID();
const CIRCLE = randomUUID();

/** Platform migration 0041_notifications_state_counted (0.1.0-next.26), as shipped. */
const MIGRATION_0041 = [
  `ALTER TABLE "notifications" ADD COLUMN "data" JSONB, ADD COLUMN "dedup_key" TEXT,
     ADD COLUMN "dismissed_at" TIMESTAMPTZ, ADD COLUMN "scope_id" UUID,
     ADD COLUMN "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP`,
  `CREATE INDEX "notifications_dismissed_at_idx" ON "notifications"("dismissed_at")`,
  `UPDATE "notifications" SET "updated_at" = COALESCE("read_at", "created_at")`,
  `CREATE UNIQUE INDEX "notifications_live_dedup_uniq_idx" ON "notifications"("user_id", "dedup_key")
     WHERE "dismissed_at" IS NULL AND "dedup_key" IS NOT NULL`,
];

describe('legacy notifications carry-over (db)', () => {
  let client: Client | null = null;
  let schema = '';
  const ids = {
    reviewLive: randomUUID(),
    reviewDismissed: randomUUID(),
    uploadOld: randomUUID(),
    uploadNew: randomUUID(),
    enrichment: randomUUID(),
    share: randomUUID(),
    workflowOtherUser: randomUUID(),
    sub: randomUUID(),
    broadcast: randomUUID(),
    delivery: randomUUID(),
  };

  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await orgScoped(client!, { bypass: true }).query(sql, params)).rows;

  async function legacyFingerprint(): Promise<string> {
    const parts: unknown[] = [];
    for (const t of [
      'mh_legacy_notifications',
      'mh_legacy_push_subscriptions',
      'mh_legacy_notification_deliveries',
      'mh_legacy_notification_broadcasts',
    ]) {
      parts.push(await q(`SELECT * FROM ${t} ORDER BY id`));
    }
    return JSON.stringify(parts);
  }

  beforeAll(async () => {
    const candidate = new Client({
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      user: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'postgres',
      database: process.env.POSTGRES_DB || 'appdb',
      connectionTimeoutMillis: 2000,
    });
    try {
      await candidate.connect();
      const have = await candidate.query(
        `SELECT to_regclass('public.mh_legacy_notifications') AS legacy, to_regclass('public.notifications') AS platform`,
      );
      if (!have.rows[0].legacy || !have.rows[0].platform) {
        throw new Error('the legacy and platform notification tables are missing: run `npm run prisma:migrate` first');
      }
    } catch (err) {
      console.warn(`Skipping legacy-notifications-migration.db.spec: ${(err as Error).message}`);
      await candidate.end().catch(() => undefined);
      return;
    }
    client = candidate;
    schema = `d3_notif_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await q(`CREATE SCHEMA ${schema}`);
    await q(`SET search_path TO ${schema}, public`);

    await q(`CREATE TABLE users (id uuid PRIMARY KEY)`);
    for (const t of [
      'mh_legacy_notifications',
      'mh_legacy_push_subscriptions',
      'mh_legacy_notification_deliveries',
      'mh_legacy_notification_broadcasts',
      'push_subscriptions',
      'notification_deliveries',
      'notification_broadcasts',
      'system_settings',
      'user_settings',
    ]) {
      await q(`CREATE TABLE ${t} (LIKE public.${t} INCLUDING ALL)`);
    }
    // The platform inbox as 0.1.0-next.22 ships it (no fold columns), whatever `public` holds.
    await q(`CREATE TABLE notifications (LIKE public.notifications INCLUDING ALL)`);
    for (const col of ['data', 'dedup_key', 'dismissed_at', 'scope_id', 'updated_at']) {
      await q(`ALTER TABLE notifications DROP COLUMN IF EXISTS ${col}`);
    }

    await q(`INSERT INTO users (id) VALUES ($1), ($2)`, [USER_A, USER_B]);
    const ins = (id: string, user: string, type: string, extra: Partial<Record<string, unknown>> = {}) =>
      q(
        `INSERT INTO mh_legacy_notifications (id, user_id, circle_id, type, title, body, link, data, read_at, dismissed_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4::"NotificationType", $5, $6, $7, $8::jsonb, $9, $10, $11, $12)`,
        [
          id, user, extra.circle === undefined ? CIRCLE : extra.circle, type, extra.title ?? 'Title X', extra.body ?? null,
          extra.link ?? null, extra.data === undefined ? null : JSON.stringify(extra.data), extra.readAt ?? null,
          extra.dismissedAt ?? null, extra.createdAt ?? '2026-01-01T00:00:00Z', extra.updatedAt ?? '2026-01-01T00:00:00Z',
        ],
      );
    await ins(ids.reviewLive, USER_A, 'review_queue_duplicates', {
      title: '929 duplicate groups ready to review in Circle A', link: '/duplicates',
      data: { count: 929, countAtRead: 900 }, readAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z',
    });
    await ins(ids.reviewDismissed, USER_A, 'review_queue_duplicates', {
      data: { count: 0 }, dismissedAt: '2025-12-01T00:00:00Z',
    });
    await ins(ids.uploadOld, USER_A, 'upload_completed', { data: { count: 12 }, updatedAt: '2026-01-01T00:00:00Z' });
    await ins(ids.uploadNew, USER_A, 'upload_completed', { data: { count: 4000 }, updatedAt: '2026-01-05T00:00:00Z' });
    await ins(ids.enrichment, USER_A, 'enrichment_failed', { circle: null, data: { jobType: 'geocode', count: 400 } });
    await ins(ids.share, USER_A, 'share_expiring', {
      data: { shareId: randomUUID(), notifiedFor: '2026-01-08T00:00:00.000Z' }, dismissedAt: '2026-01-02T00:00:00Z',
    });
    await ins(ids.workflowOtherUser, USER_B, 'workflow_run_completed', { body: 'Body X' });

    await q(
      `INSERT INTO mh_legacy_push_subscriptions (id, user_id, endpoint, p256dh, auth, failure_count, created_at, updated_at)
       VALUES ($1, $2, 'https://push.example.test/sub-1', 'p256dh-x', 'auth-x', 2, now(), now())`,
      [ids.sub, USER_A],
    );
    await q(
      `INSERT INTO mh_legacy_notification_broadcasts (id, title, body, critical, channels, status, recipient_count, processed_count, created_by_id, created_at, updated_at)
       VALUES ($1, 'Announcement X', 'Body X', true, ARRAY['inbox','push','email'], 'sent', 2, 2, $2, now(), now())`,
      [ids.broadcast, USER_A],
    );
    await q(
      `INSERT INTO mh_legacy_notification_deliveries (id, notification_id, user_id, type, channel, status, provider_message_id, created_at, updated_at)
       VALUES ($1, NULL, $2, 'memories_ready', 'push', 'sent', '1/1 sent', now(), now())`,
      [ids.delivery, USER_A],
    );
    await q(
      `INSERT INTO system_settings (id, key, value, version, updated_at) VALUES ($1, 'global', $2::jsonb, 1, now())`,
      [
        randomUUID(),
        JSON.stringify({
          features: { burstDetection: true },
          notifications: { browserEnabled: true, pushEnabled: false, disabledTypes: ['share_expiring'], retentionDays: 45, purgeEnabled: true },
        }),
      ],
    );
    await q(`INSERT INTO user_settings (id, user_id, value, version, updated_at) VALUES ($1, $2, $3::jsonb, 1, now())`, [
      randomUUID(),
      USER_A,
      JSON.stringify({ theme: 'dark', notifications: { types: { upload_completed: false }, workflowMicroRuns: true } }),
    ]);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await client.end();
  });

  it('dry run reports the plan; apply refuses without the 0041 columns and writes nothing', async () => {
    if (!client) return;
    const plan = await planNotificationsCarryOver(client);
    expect(plan.foldColumns).toBe(false);
    expect(plan.inbox.legacy).toBe(7);
    expect(plan.inbox.byType.find((t) => t.type === 'upload_completed')).toMatchObject({
      eventKey: 'media.upload_completed', total: 2, live: 2, unread: 2,
    });
    expect(plan.users).toEqual({ legacyShape: 1, withMutes: 1, withWorkflowMicroRuns: 1 });
    await expect(applyNotificationsCarryOver(client)).rejects.toThrow(/0041/);
    expect(await q(`SELECT count(*)::int AS n FROM notifications`)).toEqual([{ n: 0 }]);
    expect(await q(`SELECT count(*)::int AS n FROM push_subscriptions`)).toEqual([{ n: 0 }]);
  });

  it('refuses while a legacy broadcast is in flight', async () => {
    if (!client) return;
    for (const sql of MIGRATION_0041) await q(sql);
    const pending = randomUUID();
    await q(
      `INSERT INTO mh_legacy_notification_broadcasts (id, title, body, channels, status, created_at, updated_at)
       VALUES ($1, 'T', 'B', ARRAY['inbox'], 'scheduled', now(), now())`,
      [pending],
    );
    await expect(applyNotificationsCarryOver(client)).rejects.toThrow(/scheduled or sending/);
    await q(`DELETE FROM mh_legacy_notification_broadcasts WHERE id = $1`, [pending]);
  });

  it('copies every table under its id, idempotently, leaving the legacy tables untouched', async () => {
    if (!client) return;
    const before = await legacyFingerprint();
    const first = await applyNotificationsCarryOver(client);
    expect(first).toMatchObject({
      pushSubscriptions: 1, broadcasts: 1, inbox: 7, inboxRetiredKeys: 1, deliveries: 1,
      systemSettingsWritten: true, usersRewritten: 1,
    });

    const inbox = Object.fromEntries((await q(`SELECT * FROM notifications`)).map((r) => [r.id as string, r]));
    expect(inbox[ids.reviewLive]).toMatchObject({
      event_key: 'review.duplicates', title: '929 duplicate groups ready to review in Circle A', body: '',
      link: `/duplicates?c=${CIRCLE}`, scope_id: CIRCLE, dismissed_at: null,
      data: { count: 929, countAtRead: 900 }, dedup_key: `state:review.duplicates:${CIRCLE}`,
    });
    expect(inbox[ids.reviewLive]!.read_at).not.toBeNull();
    expect((inbox[ids.reviewLive]!.updated_at as Date).toISOString()).toBe('2026-01-03T00:00:00.000Z');
    expect(inbox[ids.reviewDismissed]!.dismissed_at).not.toBeNull();
    expect(inbox[ids.uploadNew]!.dedup_key).toBe(`counted:media.upload_completed:${CIRCLE}`);
    expect(inbox[ids.uploadOld]!.dedup_key).toBe(`retired:${ids.uploadOld}`);
    expect(inbox[ids.enrichment]).toMatchObject({
      event_key: 'media.enrichment_failed', scope_id: null,
      dedup_key: 'counted:media.enrichment_failed:-:[["jobType","geocode"]]',
    });
    expect(inbox[ids.share]).toMatchObject({ event_key: 'shares.expiring', dedup_key: null });
    expect(inbox[ids.workflowOtherUser]).toMatchObject({ user_id: USER_B, event_key: 'workflows.run_completed', body: 'Body X' });

    // The bell's unread count per user is preserved (live, unread).
    const unread = await q(
      `SELECT user_id::text AS u, count(*)::int AS n FROM notifications WHERE read_at IS NULL AND dismissed_at IS NULL GROUP BY 1 ORDER BY 1`,
    );
    const legacyUnread = await q(
      `SELECT user_id::text AS u, count(*)::int AS n FROM mh_legacy_notifications WHERE read_at IS NULL AND dismissed_at IS NULL GROUP BY 1 ORDER BY 1`,
    );
    expect(unread).toEqual(legacyUnread);

    expect(await q(`SELECT endpoint, failure_count, platform, user_id::text AS u FROM push_subscriptions`)).toEqual([
      { endpoint: 'https://push.example.test/sub-1', failure_count: 2, platform: 'browser', u: USER_A },
    ]);
    expect(
      await q(`SELECT event_key, channels, status::text AS status, recipients_targeted, recipients_dispatched, target_org_id FROM notification_broadcasts`),
    ).toEqual([
      { event_key: 'admin.broadcast_critical', channels: ['browser', 'push', 'email'], status: 'sent',
        recipients_targeted: 2, recipients_dispatched: 2, target_org_id: null },
    ]);
    expect(await q(`SELECT event_key, recipient, channel, status::text AS status FROM notification_deliveries`)).toEqual([
      { event_key: 'memories.ready', recipient: CARRIED_DELIVERY_RECIPIENT, channel: 'push', status: 'sent' },
    ]);

    const [global] = await q(`SELECT value FROM system_settings WHERE key = 'global'`);
    const doc = global!.value as Record<string, unknown>;
    expect(doc.notifications).toEqual({
      browserEnabled: true,
      disabledEvents: ['shares.expiring', 'jobs.job_failed'],
      channels: { browser: { enabled: true }, push: { enabled: false } },
    });
    expect(doc.retention).toEqual({
      notifications: { enabled: true, days: 45 },
      notificationDeliveries: { enabled: true, days: 45 },
    });
    expect(doc.mhLegacyNotifications).toMatchObject({ pushEnabled: false });
    expect(doc.features).toEqual({ burstDetection: true });

    const [prefs] = await q(`SELECT value FROM user_settings WHERE user_id = $1`, [USER_A]);
    expect(prefs!.value).toEqual({
      theme: 'dark',
      notifications: { browser: { 'media.upload_completed': false }, push: { 'media.upload_completed': false } },
      memoriahubNotifications: { workflowMicroRuns: true },
    });
    const [kept] = await q(`SELECT value FROM system_settings WHERE key = $1`, [LEGACY_PREFERENCES_ROW_KEY]);
    expect((kept!.value as Record<string, unknown>)[USER_A]).toEqual({
      types: { upload_completed: false }, workflowMicroRuns: true,
    });

    const second = await applyNotificationsCarryOver(client);
    expect(second).toMatchObject({
      pushSubscriptions: 0, broadcasts: 0, inbox: 0, deliveries: 0, systemSettingsWritten: false, usersRewritten: 0,
    });
    expect(await legacyFingerprint()).toBe(before);
  });

  it('the copied live row is the one the platform unique index protects', async () => {
    if (!client) return;
    await expect(
      q(
        `INSERT INTO notifications (id, user_id, event_key, title, body, dedup_key) VALUES ($1, $2, 'review.duplicates', 'T', '', $3)`,
        [randomUUID(), USER_A, `state:review.duplicates:${CIRCLE}`],
      ),
    ).rejects.toThrow(/notifications_live_dedup_uniq_idx/);
  });
});
