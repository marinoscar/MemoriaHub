/**
 * Notification channels + admin policy (epic #481, issue #484).
 */
import { NotificationType } from '@prisma/client';

import {
  NOTIFICATION_CHANNEL_DESCRIPTORS,
  channelDescriptor,
  isMandatoryType,
  pushCapableTypes,
} from './notification-channels';
import {
  DEFAULT_NOTIFICATION_POLICY,
  NOTIFICATION_POLICY_CACHE_TTL_MS,
  NotificationPolicyService,
  isInboxAllowed,
  isPushAllowed,
  isToastAllowed,
  policyChannels,
  readNotificationPolicy,
} from './notification-policy.service';
import * as channels from './notification-channels';

const ALL = Object.values(NotificationType) as NotificationType[];

describe('notification channel descriptors', () => {
  it('declares every NotificationType, each with inbox + push; only the critical broadcast is mandatory', () => {
    expect(Object.keys(NOTIFICATION_CHANNEL_DESCRIPTORS).sort()).toEqual([...ALL].sort());
    for (const t of ALL) {
      const mandatory = t === 'admin_broadcast_critical';
      expect(channelDescriptor(t)).toEqual({ channels: ['inbox', 'push'], mandatory });
      expect(isMandatoryType(t)).toBe(mandatory);
    }
    expect(pushCapableTypes().sort()).toEqual([...ALL].sort());
  });

  it('degrades an unknown type to inbox-only', () => {
    expect(channelDescriptor('nope' as NotificationType)).toEqual({
      channels: ['inbox'],
      mandatory: false,
    });
  });
});

describe('policy predicates', () => {
  const T = 'upload_completed' as NotificationType;

  it('the default policy allows everything', () => {
    expect(isInboxAllowed(T)).toBe(true);
    expect(isPushAllowed(T)).toBe(true);
    expect(isToastAllowed(T)).toBe(true);
    expect(policyChannels(T)).toEqual(['inbox', 'push']);
  });

  it('disabledTypes drops push AND the inbox row for a non-mandatory type', () => {
    const p = { ...DEFAULT_NOTIFICATION_POLICY, disabledTypes: [T] };
    expect(policyChannels(T, p)).toEqual([]);
    expect(isToastAllowed(T, p)).toBe(false);
    expect(policyChannels('share_expiring' as NotificationType, p)).toEqual(['inbox', 'push']);
  });

  it('a mandatory type keeps its inbox row but still loses push and toast', () => {
    const spy = jest.spyOn(channels, 'isMandatoryType').mockReturnValue(true);
    try {
      const p = { ...DEFAULT_NOTIFICATION_POLICY, disabledTypes: [T] };
      expect(isInboxAllowed(T, p)).toBe(true);
      expect(isPushAllowed(T, p)).toBe(false);
      expect(isToastAllowed(T, p)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('pushEnabled=false stops push only; browserEnabled=false stops toast only', () => {
    expect(isPushAllowed(T, { ...DEFAULT_NOTIFICATION_POLICY, pushEnabled: false })).toBe(false);
    expect(isInboxAllowed(T, { ...DEFAULT_NOTIFICATION_POLICY, pushEnabled: false })).toBe(true);
    const noBrowser = { ...DEFAULT_NOTIFICATION_POLICY, browserEnabled: false };
    expect(isToastAllowed(T, noBrowser)).toBe(false);
    expect(isPushAllowed(T, noBrowser)).toBe(true);
  });

  it('readNotificationPolicy tolerates junk and drops unknown types', () => {
    expect(readNotificationPolicy(null)).toEqual(DEFAULT_NOTIFICATION_POLICY);
    expect(readNotificationPolicy({ notifications: 'x' })).toEqual(DEFAULT_NOTIFICATION_POLICY);
    expect(
      readNotificationPolicy({
        notifications: { pushEnabled: false, disabledTypes: ['upload_completed', 'bogus', 3] },
      }),
    ).toEqual({ browserEnabled: true, pushEnabled: false, disabledTypes: ['upload_completed'] });
  });
});

describe('NotificationPolicyService', () => {
  function build(findUnique: jest.Mock) {
    return new NotificationPolicyService({ systemSettings: { findUnique } } as any);
  }

  it('reads the global row once per TTL and invalidates on demand', async () => {
    const findUnique = jest
      .fn()
      .mockResolvedValue({ value: { notifications: { pushEnabled: false } } });
    const svc = build(findUnique);
    await expect(svc.isPushAllowed('upload_completed' as NotificationType)).resolves.toBe(false);
    await svc.getPolicy();
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({ where: { key: 'global' }, select: { value: true } });
    svc.invalidate();
    await svc.getPolicy();
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('re-reads after the TTL', async () => {
    jest.useFakeTimers();
    try {
      const findUnique = jest.fn().mockResolvedValue(null);
      const svc = build(findUnique);
      await svc.getPolicy();
      jest.advanceTimersByTime(NOTIFICATION_POLICY_CACHE_TTL_MS + 1);
      await svc.getPolicy();
      expect(findUnique).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails open when the read throws', async () => {
    const svc = build(jest.fn().mockRejectedValue(new Error('db down')));
    await expect(svc.getPolicy()).resolves.toEqual(DEFAULT_NOTIFICATION_POLICY);
    await expect(svc.isInboxAllowed('upload_completed' as NotificationType)).resolves.toBe(true);
  });
});
