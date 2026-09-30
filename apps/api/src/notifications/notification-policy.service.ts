import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import {
  NotificationChannel,
  channelDescriptor,
  isMandatoryType,
  supportsChannel,
} from './notification-channels';

// =============================================================================
// NotificationPolicyService — the admin kill switches (epic #481, issue #484)
// =============================================================================
//
// Reads `notifications.{browserEnabled, pushEnabled, disabledTypes}` out of the
// `global` system_settings row WITH PRISMA DIRECTLY, not through
// SystemSettingsService: NotificationsModule imports nothing (see its header),
// and SettingsModule already imports NotificationsModule.
//
// SEMANTICS
//   disabledTypes  — suppresses the PUSH channel for a listed type, and its
//                    INBOX row too unless the type is mandatory.
//   pushEnabled    — false stops every Web Push, mandatory types included.
//   browserEnabled — false withholds the in-page browser TOAST (the SSE
//                    stream's `toast` flag); the inbox row is unaffected.
//
// CACHED 5 s (mirrors SystemSettingsService's TTL) because the gate runs per
// RECIPIENT in hot producer loops, with an explicit invalidate().
//
// FAILS OPEN: an unreadable policy resolves to "everything on". A transient DB
// fault must never silently mute notifications; the worst case of failing open
// is a push an admin had switched off, for as long as the fault lasts.
// =============================================================================

export interface NotificationPolicy {
  browserEnabled: boolean;
  pushEnabled: boolean;
  disabledTypes: readonly NotificationType[];
}

export const DEFAULT_NOTIFICATION_POLICY: NotificationPolicy = {
  browserEnabled: true,
  pushEnabled: true,
  disabledTypes: [],
};

export const NOTIFICATION_POLICY_CACHE_TTL_MS = 5000;

const ALL_TYPES = new Set<string>(Object.values(NotificationType));

/** May an inbox row be written for this type? Mandatory types always may. */
export function isInboxAllowed(
  type: NotificationType,
  policy: NotificationPolicy = DEFAULT_NOTIFICATION_POLICY,
): boolean {
  return isMandatoryType(type) || !policy.disabledTypes.includes(type);
}

/** May this type be pushed? No mandatory exemption. */
export function isPushAllowed(
  type: NotificationType,
  policy: NotificationPolicy = DEFAULT_NOTIFICATION_POLICY,
): boolean {
  return (
    supportsChannel(type, 'push') && policy.pushEnabled && !policy.disabledTypes.includes(type)
  );
}

/** May a live tab raise a browser toast for this type? No mandatory exemption. */
export function isToastAllowed(
  type: NotificationType,
  policy: NotificationPolicy = DEFAULT_NOTIFICATION_POLICY,
): boolean {
  return policy.browserEnabled && !policy.disabledTypes.includes(type);
}

/** A type's declared channels narrowed by policy. Fresh array. */
export function policyChannels(
  type: NotificationType,
  policy: NotificationPolicy = DEFAULT_NOTIFICATION_POLICY,
): NotificationChannel[] {
  return channelDescriptor(type).channels.filter((c) =>
    c === 'inbox' ? isInboxAllowed(type, policy) : isPushAllowed(type, policy),
  );
}

/** Normalize an arbitrary stored `notifications` namespace. Never throws. */
export function readNotificationPolicy(value: unknown): NotificationPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_NOTIFICATION_POLICY;
  }
  const ns = (value as Record<string, unknown>)['notifications'];
  if (!ns || typeof ns !== 'object' || Array.isArray(ns)) return DEFAULT_NOTIFICATION_POLICY;
  const n = ns as Record<string, unknown>;
  const disabled = Array.isArray(n.disabledTypes)
    ? (n.disabledTypes.filter(
        (t): t is NotificationType => typeof t === 'string' && ALL_TYPES.has(t),
      ) as NotificationType[])
    : [];
  return {
    // `!== false`: absent and malformed both mean on.
    browserEnabled: n.browserEnabled !== false,
    pushEnabled: n.pushEnabled !== false,
    disabledTypes: disabled,
  };
}

@Injectable()
export class NotificationPolicyService {
  private readonly logger = new Logger(NotificationPolicyService.name);
  private cache: { value: NotificationPolicy; cachedAt: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** The current policy. Cached for NOTIFICATION_POLICY_CACHE_TTL_MS; fail-open. */
  async getPolicy(): Promise<NotificationPolicy> {
    const now = Date.now();
    if (this.cache && now - this.cache.cachedAt < NOTIFICATION_POLICY_CACHE_TTL_MS) {
      return this.cache.value;
    }
    try {
      const row = await this.prisma.systemSettings.findUnique({
        where: { key: 'global' },
        select: { value: true },
      });
      const value = readNotificationPolicy(row?.value);
      this.cache = { value, cachedAt: now };
      return value;
    } catch (err) {
      this.logger.warn(
        `notification policy read failed, defaulting to all-enabled: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return DEFAULT_NOTIFICATION_POLICY;
    }
  }

  async isInboxAllowed(type: NotificationType): Promise<boolean> {
    return isInboxAllowed(type, await this.getPolicy());
  }

  async isPushAllowed(type: NotificationType): Promise<boolean> {
    return isPushAllowed(type, await this.getPolicy());
  }

  async isToastAllowed(type: NotificationType): Promise<boolean> {
    return isToastAllowed(type, await this.getPolicy());
  }

  /** Drop the cached policy (e.g. after a settings write in this process). */
  invalidate(): void {
    this.cache = null;
  }
}
