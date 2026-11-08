// The swap point of the settings contract spec: builds the implementation under
// test. BEFORE RETRO-B3 this wired the hand-written `SystemSettingsService` and
// `UserSettingsService` and validated bodies with their wire DTOs.

import { Test } from '@nestjs/testing';

import { PrismaService } from '../../src/prisma/prisma.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { NotificationPolicyService } from '../../src/notifications/notification-policy.service';
import { SystemSettingsService } from '../../src/settings/system-settings/system-settings.service';
import { UserSettingsService } from '../../src/settings/user-settings/user-settings.service';
import { UserTimeZoneService } from '../../src/settings/user-settings/user-timezone.service';
// The CANONICAL partial, not the wire DTO: the wire DTO strips `email`, `workflows`, `backup` and
// others (the very pitfall RETRO-B3 retires), so it is not a contract worth pinning.
import { systemSettingsPatchSchema as patchSystemSettingsSchema } from '../../src/common/schemas/settings.schema';
import { patchUserSettingsSchema } from '../../src/settings/dto/update-user-settings.dto';
import { createFakeSettingsDb, type FakeSettingsDb } from './settings-contract.fake-prisma';

export interface SettingsHarness {
  db: FakeSettingsDb;
  notifications: { dismissTypesForUser: jest.Mock; dismissTypesGlobally: jest.Mock; invalidatePreferences: jest.Mock };
  timeZone: { invalidate: jest.Mock };
  system: {
    /** Seed the `global` row with `value` (default: the stored defaults). */
    seed(value: Record<string, unknown>): void;
    /** The JSON the `global` row holds right now. */
    raw(): Record<string, any>;
    /** `GET /api/system-settings`, as the client sees it. */
    get(): Promise<Record<string, any>>;
    /** `PATCH /api/system-settings`: wire validation, then the service. */
    patch(body: unknown, expectedVersion?: number): Promise<Record<string, any>>;
    /** Wire validation of a PATCH body alone; returns the zod result. */
    validatePatch(body: unknown): { success: boolean };
  };
  user: {
    seed(userId: string, value: Record<string, unknown>): void;
    raw(userId: string): Record<string, any>;
    get(userId: string): Promise<Record<string, any>>;
    patch(userId: string, body: unknown, expectedVersion?: number): Promise<Record<string, any>>;
    validatePatch(body: unknown): { success: boolean };
  };
}

function redactEmailSecret<T extends { email?: any }>(settings: T): T {
  if (settings && settings.email) {
    const { smtpPassword: _omitted, ...rest } = settings.email as Record<string, unknown>;
    return { ...settings, email: rest } as T;
  }
  return settings;
}

export async function buildSettingsHarness(): Promise<SettingsHarness> {
  const db = createFakeSettingsDb();
  const notifications = {
    dismissTypesForUser: jest.fn().mockResolvedValue(0),
    dismissTypesGlobally: jest.fn().mockResolvedValue(0),
    invalidatePreferences: jest.fn(),
    invalidateAllUnreadCounts: jest.fn(),
  };
  const timeZone = { invalidate: jest.fn() };

  const module = await Test.createTestingModule({
    providers: [
      SystemSettingsService,
      UserSettingsService,
      { provide: PrismaService, useValue: db.prisma },
      { provide: NotificationsService, useValue: notifications },
      { provide: NotificationPolicyService, useValue: { invalidate: jest.fn() } },
      { provide: UserTimeZoneService, useValue: timeZone },
    ],
  }).compile();

  const system = module.get(SystemSettingsService);
  const user = module.get(UserSettingsService);

  return {
    db,
    notifications,
    timeZone,
    system: {
      seed: (value) => {
        db.system.set('global', { id: 'sys-0', key: 'global', value, version: 1, updatedAt: new Date(), updatedByUserId: null });
      },
      raw: () => JSON.parse(JSON.stringify(db.system.get('global')!.value)),
      get: async () => redactEmailSecret(await system.getSettings()),
      patch: async (body, expectedVersion) => {
        const parsed = patchSystemSettingsSchema.parse(body);
        return redactEmailSecret(await system.patchSettings(parsed as any, 'admin-1', expectedVersion));
      },
      validatePatch: (body) => patchSystemSettingsSchema.safeParse(body),
    },
    user: {
      seed: (userId, value) => {
        db.user.set(userId, { id: `us-${userId}`, userId, value, version: 1, updatedAt: new Date() });
      },
      raw: (userId) => JSON.parse(JSON.stringify(db.user.get(userId)!.value)),
      get: (userId) => user.getSettings(userId) as Promise<Record<string, any>>,
      patch: (userId, body, expectedVersion) =>
        user.patchSettings(userId, patchUserSettingsSchema.parse(body) as any, expectedVersion) as Promise<Record<string, any>>,
      validatePatch: (body) => patchUserSettingsSchema.safeParse(body),
    },
  };
}
