import { NotificationType } from '@prisma/client';
import {
  NOTIFICATION_EVENT_KEY_PATTERN,
  channelsFor,
  eventBrowserTemplateRegistry,
  findEvent,
  isMandatory,
  notificationEventRegistry,
} from '@marinoscar/platform-api/notifications';

import '../platform/notifications/notification.manifest';
import {
  LEGACY_NOTIFICATION_TYPE_TO_EVENT_KEY,
  MEMORIAHUB_EVENT_KEYS,
  MEMORIAHUB_NOTIFICATIONS,
  MEMORIAHUB_NOTIFICATION_FOLDS,
  countedDedupKey,
  memoriahubDedupKey,
  relativeExpiry,
  stateDedupKey,
} from './memoriahub.notifications';

const CIRCLE = '00000000-0000-4000-8000-000000000001';

function render(key: string, data: unknown) {
  const binding = eventBrowserTemplateRegistry.get(key);
  if (!binding) throw new Error(`no browser template for ${key}`);
  return (binding.render as (d: unknown) => { title: string; body: string; link?: string })(data);
}

describe('MemoriaHub notification registry', () => {
  it('declares exactly the nine permanent keys', () => {
    expect(Object.values(MEMORIAHUB_EVENT_KEYS).sort()).toEqual(
      [
        'media.enrichment_failed',
        'media.upload_completed',
        'memories.ready',
        'review.bursts',
        'review.duplicates',
        'review.enhancements',
        'review.location_suggestions',
        'shares.expiring',
        'workflows.run_completed',
      ].sort(),
    );
    expect(MEMORIAHUB_NOTIFICATIONS.map((r) => r.event.key).sort()).toEqual(Object.values(MEMORIAHUB_EVENT_KEYS).sort());
  });

  it('maps every legacy NotificationType to a registered event', () => {
    const legacy = Object.values(NotificationType);
    expect(Object.keys(LEGACY_NOTIFICATION_TYPE_TO_EVENT_KEY).sort()).toEqual([...legacy].sort());
    for (const type of legacy) {
      const key = LEGACY_NOTIFICATION_TYPE_TO_EVENT_KEY[type];
      expect(key).toMatch(NOTIFICATION_EVENT_KEY_PATTERN);
      expect(notificationEventRegistry.has(key)).toBe(true);
    }
    expect(LEGACY_NOTIFICATION_TYPE_TO_EVENT_KEY.admin_broadcast).toBe('admin.broadcast');
    expect(LEGACY_NOTIFICATION_TYPE_TO_EVENT_KEY.admin_broadcast_critical).toBe('admin.broadcast_critical');
  });

  it('declares browser and push, default on, none mandatory, and a renderer for each', () => {
    for (const key of Object.values(MEMORIAHUB_EVENT_KEYS)) {
      const event = findEvent(key);
      expect(event?.defaultEnabled).toBe(true);
      expect(isMandatory(key)).toBe(false);
      expect([...channelsFor(key)].sort()).toEqual(['browser', 'push']);
      expect(eventBrowserTemplateRegistry.has(key)).toBe(true);
      expect(MEMORIAHUB_NOTIFICATION_FOLDS[key]).toBeDefined();
    }
  });

  it('keeps the producers\' pluralised titles and root-relative links', () => {
    expect(render('review.bursts', { count: 1, circleName: 'Circle A' })).toEqual({
      title: '1 burst group ready to review in Circle A',
      body: '',
      link: '/bursts',
    });
    expect(render('review.duplicates', { count: 929, circleName: 'Circle A' }).title).toBe(
      '929 duplicate groups ready to review in Circle A',
    );
    expect(render('review.enhancements', { count: 2, circleName: 'Circle A' }).title).toBe(
      '2 AI enhancements awaiting review in Circle A',
    );
    expect(render('review.location_suggestions', { count: 3 }).link).toBe('/location-suggestions');
    expect(render('media.upload_completed', { count: 4000, circleName: 'Circle A' }).title).toBe(
      '4000 items uploaded to Circle A',
    );
    expect(render('media.upload_completed', { count: 1, circleName: 'Circle A', uploaderName: 'Person A' }).title).toBe(
      'Person A added 1 photo to Circle A',
    );
    const failed = render('media.enrichment_failed', { count: 400, jobType: 'geocode', lastError: 'boom' });
    expect(failed).toEqual({
      title: '400 geocode jobs failed permanently',
      body: 'boom',
      link: '/admin/settings/jobs?status=failed',
    });
    expect(
      render('workflows.run_completed', { runId: 'run-1', workflowName: 'Flow X', succeededCount: 5, failedCount: 1 }),
    ).toEqual({ title: "Workflow 'Flow X' finished: 5 applied, 1 failed", body: '', link: '/workflows/runs/run-1' });
    expect(render('workflows.run_completed', { runId: '../../x' }).link).toBe('/workflows');
    expect(render('memories.ready', { count: 6, circleName: 'Circle A', topTitle: 'Trip to Place X' })).toEqual({
      title: '6 new memories in Circle A',
      body: 'Trip to Place X',
      link: '/memories',
    });
    expect(render('shares.expiring', { targetName: 'Album X', notifiedFor: 'not-a-date' }).title).toBe(
      "A public share of 'Album X' expires soon",
    );
  });

  it('renders a row written before its fields existed', () => {
    for (const key of Object.values(MEMORIAHUB_EVENT_KEYS)) {
      expect(() => render(key, null)).not.toThrow();
      expect(render(key, undefined).title.length).toBeGreaterThan(0);
    }
  });

  it('buckets expiries on elapsed time', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(relativeExpiry(new Date('2026-01-01T03:00:00Z'), now)).toBe('today');
    expect(relativeExpiry(new Date('2026-01-02T05:00:00Z'), now)).toBe('tomorrow');
    expect(relativeExpiry(new Date('2026-01-05T00:00:00Z'), now)).toBe('in 4 days');
  });

  describe('dedup keys (mirror platform 0.1.0-next.26 notification-inbox-writer)', () => {
    it('formats STATE and COUNTED keys exactly as the platform', () => {
      expect(stateDedupKey('review.bursts', CIRCLE)).toBe(`state:review.bursts:${CIRCLE}`);
      expect(stateDedupKey('review.bursts', null)).toBe('state:review.bursts:-');
      expect(countedDedupKey('media.enrichment_failed', null, { jobType: 'geocode' })).toBe(
        'counted:media.enrichment_failed:-:[["jobType","geocode"]]',
      );
      expect(countedDedupKey('x.y', null, { b: 1, a: true })).toBe('counted:x.y:-:[["a",true],["b",1]]');
      expect(countedDedupKey('media.upload_completed', CIRCLE, undefined)).toBe(`counted:media.upload_completed:${CIRCLE}`);
    });

    it('caps long keys with a hash', () => {
      const key = countedDedupKey('media.enrichment_failed', null, { jobType: 'x'.repeat(300) });
      expect(key.length).toBe(120 + 1 + 40);
      expect(key).toMatch(/^counted:media\.enrichment_failed:-:.{80,}#[0-9a-f]{40}$/);
    });

    it('derives each event\'s key from its fold', () => {
      expect(memoriahubDedupKey('review.duplicates', CIRCLE, {})).toBe(`state:review.duplicates:${CIRCLE}`);
      expect(memoriahubDedupKey('media.upload_completed', CIRCLE, { uploaderId: 'u' })).toBe(
        `counted:media.upload_completed:${CIRCLE}`,
      );
      expect(memoriahubDedupKey('media.enrichment_failed', CIRCLE, { jobType: 'geocode', lastError: 'e' })).toBe(
        'counted:media.enrichment_failed:-:[["jobType","geocode"]]',
      );
      expect(memoriahubDedupKey('memories.ready', CIRCLE, { circleId: CIRCLE })).toBe(`counted:memories.ready:${CIRCLE}`);
      expect(memoriahubDedupKey('workflows.run_completed', CIRCLE, {})).toBeNull();
      expect(memoriahubDedupKey('shares.expiring', CIRCLE, {})).toBeNull();
      expect(memoriahubDedupKey('admin.broadcast', null, {})).toBeNull();
    });
  });
});
