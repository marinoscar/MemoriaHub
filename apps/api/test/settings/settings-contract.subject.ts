// The swap point of the settings contract spec: builds the implementation under test.
//
// BEFORE RETRO-B3 this wired the hand-written `SystemSettingsService` and `UserSettingsService` and
// validated bodies with the canonical schemas. NOW it wires the app's subclasses of the platform
// settings services (the ones `platform/settings/settings.config.ts` binds to the platform tokens)
// and validates bodies with the schemas the platform composes from the registry, which are the
// schemas the real controllers validate against.

import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PLATFORM_PRISMA } from '@marinoscar/platform-api/core';
import { PrincipalCache } from '@marinoscar/platform-api/identity';
import {
  SETTINGS_OPTIONS,
  SETTINGS_PROFILE_IMAGES,
  composePatchSystemSettingsSchema,
  composePatchUserSettingsSchema,
} from '@marinoscar/platform-api/settings';

import '../../src/settings/registry';
import { AppSystemSettingsService } from '../../src/platform/settings/app-system-settings.service';
import { AppUserSettingsService } from '../../src/platform/settings/app-user-settings.service';
import { SettingsProfileImagesAdapter } from '../../src/platform/settings/settings-profile-images.adapter';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { NotificationPolicyService } from '../../src/notifications/notification-policy.service';
import { UserTimeZoneService } from '../../src/settings/user-timezone.service';
import { createFakeSettingsDb, type FakeSettingsDb } from './settings-contract.fake-prisma';

export interface SettingsHarness {
  db: FakeSettingsDb;
  notifications: {
    dismissTypesForUser: jest.Mock;
    dismissTypesGlobally: jest.Mock;
    invalidatePreferences: jest.Mock;
    invalidateAllUnreadCounts: jest.Mock;
  };
  timeZone: { invalidate: jest.Mock };
  policy: { invalidate: jest.Mock };
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
    /** Drops the settings cache (as a write by another process would be seen after the TTL). */
    invalidateCache(): void;
  };
  user: {
    seed(userId: string, value: Record<string, unknown>): void;
    raw(userId: string): Record<string, any>;
    get(userId: string): Promise<Record<string, any>>;
    patch(userId: string, body: unknown, expectedVersion?: number): Promise<Record<string, any>>;
    validatePatch(body: unknown): { success: boolean };
  };
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
  const policy = { invalidate: jest.fn() };

  const module = await Test.createTestingModule({
    providers: [
      AppSystemSettingsService,
      AppUserSettingsService,
      { provide: PLATFORM_PRISMA, useValue: db.prisma },
      { provide: ConfigService, useValue: { get: (_key: string, fallback: unknown) => fallback } },
      { provide: SETTINGS_OPTIONS, useValue: { systemRowKey: 'global', orgLayer: 'auto', imports: [] } },
      { provide: PrincipalCache, useValue: { invalidate: jest.fn() } },
      { provide: SETTINGS_PROFILE_IMAGES, useClass: SettingsProfileImagesAdapter },
      { provide: NotificationsService, useValue: notifications },
      { provide: NotificationPolicyService, useValue: policy },
      { provide: UserTimeZoneService, useValue: timeZone },
    ],
  }).compile();

  const system = module.get(AppSystemSettingsService);
  const user = module.get(AppUserSettingsService);
  const patchSystem = composePatchSystemSettingsSchema();
  const patchUser = composePatchUserSettingsSchema();

  return {
    db,
    notifications,
    timeZone,
    policy,
    system: {
      seed: (value) => {
        db.system.set('global', { id: 'sys-0', key: 'global', value, version: 1, updatedAt: new Date(), updatedByUserId: null });
      },
      raw: () => JSON.parse(JSON.stringify(db.system.get('global')!.value)),
      get: async () => (await system.getSettings()) as Record<string, any>,
      patch: async (body, expectedVersion) =>
        (await system.patchSettings(patchSystem.parse(body) as any, 'admin-1', expectedVersion)) as Record<string, any>,
      validatePatch: (body) => patchSystem.safeParse(body),
      invalidateCache: () => system.invalidateSettingsCache(),
    },
    user: {
      seed: (userId, value) => {
        db.user.set(userId, { id: `us-${userId}`, userId, value, version: 1, updatedAt: new Date() });
      },
      raw: (userId) => JSON.parse(JSON.stringify(db.user.get(userId)!.value)),
      get: (userId) => user.getSettings(userId) as Promise<Record<string, any>>,
      patch: (userId, body, expectedVersion) =>
        user.patchSettings(userId, patchUser.parse(body) as any, expectedVersion) as Promise<Record<string, any>>,
      validatePatch: (body) => patchUser.safeParse(body),
    },
  };
}
