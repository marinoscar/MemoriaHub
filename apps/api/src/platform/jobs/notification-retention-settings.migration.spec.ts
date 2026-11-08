import { planNotificationRetentionCarryOver } from './notification-retention-settings.migration';

describe('planNotificationRetentionCarryOver (RETRO-C8)', () => {
  it('carries both legacy keys into an absent retention entry', () => {
    const stored = {
      notifications: { retentionDays: 45, purgeEnabled: false, browserEnabled: true },
      retention: { workflowRuns: { enabled: true, days: 30 } },
    };
    const { change, next } = planNotificationRetentionCarryOver(stored);
    expect(change).toEqual({ key: 'appNotifications', action: 'write', enabled: false, days: 45 });
    expect(next['retention']).toEqual({
      workflowRuns: { enabled: true, days: 30 },
      appNotifications: { enabled: false, days: 45 },
    });
    // The old keys stay (RETRO-C11 removes them) and the input is not mutated.
    expect(next['notifications']).toEqual(stored.notifications);
    expect(stored.retention).toEqual({ workflowRuns: { enabled: true, days: 30 } });
  });

  it('fills a missing half from the policy defaults', () => {
    expect(planNotificationRetentionCarryOver({ notifications: { retentionDays: 7 } }).change).toMatchObject({
      action: 'write',
      enabled: true,
      days: 7,
    });
    expect(planNotificationRetentionCarryOver({ notifications: { purgeEnabled: false } }).change).toMatchObject({
      action: 'write',
      enabled: false,
      days: 30,
    });
  });

  it('is idempotent: a second pass over its own output keeps everything', () => {
    const first = planNotificationRetentionCarryOver({ notifications: { retentionDays: 45 } }).next;
    const second = planNotificationRetentionCarryOver(first);
    expect(second.change.action).toBe('keep');
    expect(second.next).toEqual(first);
  });

  it('never overwrites a retention entry an operator already saved', () => {
    const { change, next } = planNotificationRetentionCarryOver({
      notifications: { retentionDays: 45 },
      retention: { appNotifications: { enabled: false, days: 90 } },
    });
    expect(change).toMatchObject({ action: 'keep', enabled: false, days: 90 });
    expect(next['retention']).toEqual({ appNotifications: { enabled: false, days: 90 } });
  });

  it('skips when nothing usable is stored', () => {
    expect(planNotificationRetentionCarryOver(null).change.action).toBe('skip');
    const { change, next } = planNotificationRetentionCarryOver({ notifications: { retentionDays: 9999 } });
    expect(change.action).toBe('skip');
    expect(next['retention']).toBeUndefined();
  });
});
