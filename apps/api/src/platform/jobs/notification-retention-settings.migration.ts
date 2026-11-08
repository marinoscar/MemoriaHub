import { APP_NOTIFICATIONS_RETENTION_POLICY } from '../../notifications/notifications.retention';

// =============================================================================
// Carry the notification purge settings into `retention.*` (RETRO-C8, #608)
// =============================================================================
//
//   notifications.retentionDays -> retention.appNotifications.days
//   notifications.purgeEnabled  -> retention.appNotifications.enabled
//
// A pure planner over the stored `system_settings` `global` value, run by
// `scripts/migrate-notification-retention-settings.ts`.
//
// IDEMPOTENT BY CONSTRUCTION, like the run-history carry-over (RETRO-C7): the
// policy is written only while `retention.appNotifications` is ABSENT from the
// stored row. A missing or out-of-range legacy value takes the policy default
// (30 days, enabled); when neither legacy key is stored there is nothing to
// carry and the policy reads as its defaults. The old keys are left in place;
// RETRO-C11 removes them.
// =============================================================================

/** The carry-over decision. */
export interface NotificationRetentionCarryOver {
  readonly key: string;
  /** `write`: the policy is set; `keep`: retention already stored; `skip`: no legacy value. */
  readonly action: 'write' | 'keep' | 'skip';
  readonly enabled: boolean | null;
  readonly days: number | null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Plans the carry-over and returns the next stored value (a copy; the input is not mutated). */
export function planNotificationRetentionCarryOver(stored: unknown): {
  change: NotificationRetentionCarryOver;
  next: Record<string, unknown>;
} {
  const policy = APP_NOTIFICATIONS_RETENTION_POLICY;
  const root: Record<string, unknown> = isObject(stored) ? structuredClone(stored) : {};
  const retention: Record<string, unknown> = isObject(root['retention']) ? { ...root['retention'] } : {};

  const current = retention[policy.key];
  if (isObject(current)) {
    return {
      change: {
        key: policy.key,
        action: 'keep',
        enabled: typeof current['enabled'] === 'boolean' ? current['enabled'] : null,
        days: typeof current['days'] === 'number' ? current['days'] : null,
      },
      next: root,
    };
  }

  const ns = isObject(root['notifications']) ? root['notifications'] : {};
  const rawDays = ns['retentionDays'];
  const rawEnabled = ns['purgeEnabled'];
  const days =
    typeof rawDays === 'number' &&
    Number.isInteger(rawDays) &&
    rawDays >= (policy.minDays ?? 1) &&
    rawDays <= (policy.maxDays ?? 3650)
      ? rawDays
      : null;
  const enabled = typeof rawEnabled === 'boolean' ? rawEnabled : null;

  if (days === null && enabled === null) {
    return { change: { key: policy.key, action: 'skip', enabled: null, days: null }, next: root };
  }

  const value = { enabled: enabled ?? policy.defaultEnabled ?? false, days: days ?? policy.defaultDays };
  retention[policy.key] = value;
  root['retention'] = retention;
  return { change: { key: policy.key, action: 'write', ...value }, next: root };
}
