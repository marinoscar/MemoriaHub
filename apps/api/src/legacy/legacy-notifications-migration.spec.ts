import {
  LEGACY_NOTIFICATIONS_SETTINGS_KEY,
  PLATFORM_JOB_FAILED_EVENT_KEY,
  applyNotificationsCarryOver,
  eventKeyCaseSql,
  isLegacySystemPolicy,
  isLegacyUserPreferences,
  planInboxRows,
  transformSystemSettingsDocument,
  transformUserPreferences,
  type LegacyInboxRow,
  type SqlClient,
} from './legacy-notifications-migration';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b1';
const CIRCLE = '00000000-0000-4000-8000-0000000000c1';

function row(over: Partial<LegacyInboxRow> & Pick<LegacyInboxRow, 'id' | 'type'>): LegacyInboxRow {
  return {
    user_id: USER_A,
    circle_id: CIRCLE,
    title: 'Title X',
    body: null,
    link: null,
    data: null,
    read_at: null,
    dismissed_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

describe('transformSystemSettingsDocument', () => {
  it('rewrites the policy, maps disabled types, suppresses jobs.job_failed and keeps the original', () => {
    const legacy = {
      browserEnabled: false,
      pushEnabled: false,
      disabledTypes: ['upload_completed', 'review_queue_bursts'],
      retentionDays: 45,
      purgeEnabled: false,
    };
    const out = transformSystemSettingsDocument({ features: { x: true }, notifications: legacy });
    expect(out.changed).toBe(true);
    expect(out.next.notifications).toEqual({
      browserEnabled: false,
      disabledEvents: ['media.upload_completed', 'review.bursts', PLATFORM_JOB_FAILED_EVENT_KEY],
      channels: { browser: { enabled: false }, push: { enabled: false } },
    });
    expect(out.next.retention).toEqual({
      notifications: { enabled: false, days: 45 },
      notificationDeliveries: { enabled: false, days: 45 },
    });
    expect(out.next[LEGACY_NOTIFICATIONS_SETTINGS_KEY]).toEqual(legacy);
    expect(out.next.features).toEqual({ x: true });
  });

  it('is idempotent and never overwrites a stored retention policy', () => {
    const first = transformSystemSettingsDocument({
      notifications: { browserEnabled: true, pushEnabled: true, disabledTypes: [], retentionDays: 30, purgeEnabled: true },
      retention: { notifications: { enabled: true, days: 7 } },
    });
    expect((first.next.retention as Record<string, unknown>).notifications).toEqual({ enabled: true, days: 7 });
    const second = transformSystemSettingsDocument(first.next);
    expect(second.changed).toBe(false);
    expect(second.next).toEqual(first.next);
    expect(isLegacySystemPolicy(first.next.notifications)).toBe(false);
  });

  it("prefers RETRO-C8's retention.appNotifications over the legacy keys and leaves it in place", () => {
    const out = transformSystemSettingsDocument({
      notifications: { retentionDays: 30, purgeEnabled: true },
      retention: { appNotifications: { enabled: false, days: 12 } },
    });
    expect(out.next.retention).toEqual({
      appNotifications: { enabled: false, days: 12 },
      notifications: { enabled: false, days: 12 },
      notificationDeliveries: { enabled: false, days: 12 },
    });
  });

  it('leaves a document with no notifications alone', () => {
    expect(transformSystemSettingsDocument({}).changed).toBe(false);
    expect(transformSystemSettingsDocument(null).changed).toBe(false);
  });

  it('warns about the mandatory critical broadcast and unknown types', () => {
    const out = transformSystemSettingsDocument({
      notifications: { disabledTypes: ['admin_broadcast_critical', 'not_a_type'] },
    });
    expect((out.next.notifications as { disabledEvents: string[] }).disabledEvents).toContain('admin.broadcast_critical');
    expect(out.warnings.join('\n')).toMatch(/mandatory/);
    expect(out.warnings.join('\n')).toMatch(/not_a_type/);
  });
});

describe('transformUserPreferences', () => {
  it('absent means enabled: nothing stored', () => {
    expect(transformUserPreferences({})).toEqual({ notifications: undefined, memoriahub: undefined });
    expect(transformUserPreferences(undefined)).toEqual({ notifications: undefined, memoriahub: undefined });
  });

  it('an inbox-muted type mutes browser and push; a push-muted type only push', () => {
    const out = transformUserPreferences({
      types: { upload_completed: false, memories_ready: true },
      push: { types: { review_queue_duplicates: false } },
    });
    expect(out.notifications).toEqual({
      browser: { 'media.upload_completed': false },
      push: { 'media.upload_completed': false, 'review.duplicates': false },
    });
  });

  it('enabled:false mutes every non-mandatory event on both channels', () => {
    const out = transformUserPreferences({ enabled: false });
    expect(Object.keys(out.notifications!.browser!).sort()).toEqual(
      [
        'admin.broadcast',
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
    expect(out.notifications!.browser!['admin.broadcast_critical']).toBeUndefined();
  });

  it('push.enabled:false mutes push only', () => {
    const out = transformUserPreferences({ push: { enabled: false } });
    expect(out.notifications!.browser).toBeUndefined();
    expect(out.notifications!.push!['memories.ready']).toBe(false);
  });

  it('carries workflowMicroRuns (absent means false) to the app namespace', () => {
    expect(transformUserPreferences({ workflowMicroRuns: true }).memoriahub).toEqual({ workflowMicroRuns: true });
    expect(transformUserPreferences({ workflowMicroRuns: false }).memoriahub).toBeUndefined();
  });

  it('recognises the legacy shape but not the platform one', () => {
    expect(isLegacyUserPreferences({ types: {} })).toBe(true);
    expect(isLegacyUserPreferences({ push: { enabled: false } })).toBe(true);
    expect(isLegacyUserPreferences({ push: { 'memories.ready': false } })).toBe(false);
    expect(isLegacyUserPreferences({ browser: { 'review.bursts': false } })).toBe(false);
  });
});

describe('planInboxRows', () => {
  it('maps columns and keeps the state key on the one live review row', () => {
    const [mapped] = planInboxRows([
      row({ id: 'a', type: 'review_queue_duplicates', data: { count: 929, countAtRead: 900 }, read_at: new Date() }),
    ]);
    expect(mapped).toMatchObject({
      eventKey: 'review.duplicates',
      body: '',
      scopeId: CIRCLE,
      dedupKey: `state:review.duplicates:${CIRCLE}`,
      data: { count: 929, countAtRead: 900 },
    });
  });

  it('retires older live windows of a counted event and keeps dismissed rows keyed', () => {
    const planned = planInboxRows([
      row({ id: 'old', type: 'upload_completed', updated_at: new Date('2026-01-01T00:00:00Z') }),
      row({ id: 'new', type: 'upload_completed', updated_at: new Date('2026-01-02T00:00:00Z') }),
      row({ id: 'gone', type: 'upload_completed', dismissed_at: new Date() }),
      row({ id: 'other-user', type: 'upload_completed', user_id: USER_B }),
    ]);
    const byId = Object.fromEntries(planned.map((r) => [r.id, r.dedupKey]));
    expect(byId.new).toBe(`counted:media.upload_completed:${CIRCLE}`);
    expect(byId.old).toBe('retired:old');
    expect(byId.gone).toBe(`counted:media.upload_completed:${CIRCLE}`);
    expect(byId['other-user']).toBe(`counted:media.upload_completed:${CIRCLE}`);
  });

  it('partitions enrichment failures by job type, deployment-wide', () => {
    const planned = planInboxRows([
      row({ id: 'g', type: 'enrichment_failed', circle_id: null, data: { jobType: 'geocode', count: 3 } }),
      row({ id: 't', type: 'enrichment_failed', circle_id: null, data: { jobType: 'auto_tagging', count: 1 } }),
    ]);
    expect(planned.map((r) => r.dedupKey)).toEqual([
      'counted:media.enrichment_failed:-:[["jobType","geocode"]]',
      'counted:media.enrichment_failed:-:[["jobType","auto_tagging"]]',
    ]);
  });

  it('retires a legacy row whose key a platform row already holds live', () => {
    const [mapped] = planInboxRows(
      [row({ id: 'a', type: 'review_queue_bursts' })],
      new Set([`${USER_A}|state:review.bursts:${CIRCLE}`]),
    );
    expect(mapped.dedupKey).toBe('retired:a');
  });

  it('leaves per-occurrence events unkeyed', () => {
    const planned = planInboxRows([
      row({ id: 'w', type: 'workflow_run_completed' }),
      row({ id: 's', type: 'share_expiring', data: { notifiedFor: '2026-01-08T00:00:00.000Z' } }),
      row({ id: 'b', type: 'admin_broadcast_critical', circle_id: null }),
    ]);
    expect(planned.map((r) => [r.eventKey, r.dedupKey])).toEqual([
      ['workflows.run_completed', null],
      ['shares.expiring', null],
      ['admin.broadcast_critical', null],
    ]);
  });
});

describe('eventKeyCaseSql', () => {
  it('names every legacy type', () => {
    const sql = eventKeyCaseSql('l.type');
    expect(sql).toContain("WHEN 'review_queue_location_suggestions' THEN 'review.location_suggestions'");
    expect(sql).toContain("WHEN 'admin_broadcast' THEN 'admin.broadcast'");
  });
});

describe('applyNotificationsCarryOver', () => {
  it('refuses before the platform inbox has the fold columns, writing nothing', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ column_name: 'data' }] });
    const client: SqlClient = { query };
    await expect(applyNotificationsCarryOver(client)).rejects.toThrow(/0041_notifications_state_counted/);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
