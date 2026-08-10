/**
 * Location Grouping settings — the FOUR-hand-maintained-copies regression test
 * (issue #373).
 *
 * A settings namespace in this repo must be declared in FOUR places:
 *   1. systemSettingsSchema          (validation + defaults)
 *   2. systemSettingsPatchSchema     (all-optional twin)
 *   3. patchSystemSettingsSchema     (THE WIRE DTO — strips unknown keys)
 *   4. SystemSettingsService.patchSettings + both getSettings() projections
 *
 * A namespace missing from copy #3 validates and merges perfectly in unit
 * tests while EVERY REAL PATCH SILENTLY NO-OPS: nestjs-zod strips the unknown
 * key before the service ever sees it. This spec drives the value through the
 * REAL wire DTO first, so that failure mode is caught.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { createMockPrismaService, MockPrismaService } from '../../test/mocks/prisma.mock';
import { patchSystemSettingsSchema } from '../settings/dto/update-system-settings.dto';
import {
  systemSettingsSchema,
  systemSettingsPatchSchema,
} from '../common/schemas/settings.schema';
import {
  DEFAULT_SYSTEM_SETTINGS,
  FEATURE_KEYS,
  isLocationGroupingEnabled,
} from '../common/types/settings.types';

describe('locationGrouping settings — all four hand-maintained copies', () => {
  // ---------------------------------------------------------------------------
  // Copy 1 — systemSettingsSchema
  // ---------------------------------------------------------------------------
  describe('copy 1: systemSettingsSchema (validation + defaults)', () => {
    it('supplies the documented defaults when the namespace is absent', () => {
      const parsed = systemSettingsSchema.parse({
        ...DEFAULT_SYSTEM_SETTINGS,
        locationGrouping: undefined,
      });

      expect(parsed.locationGrouping).toEqual({
        radiusCaptureEnabled: true,
        maxRadiusKm: 50,
        suggestionMinItems: 1,
      });
    });

    it('rejects an out-of-range maxRadiusKm', () => {
      const attempt = (maxRadiusKm: number) =>
        systemSettingsSchema.safeParse({
          ...DEFAULT_SYSTEM_SETTINGS,
          locationGrouping: { radiusCaptureEnabled: true, maxRadiusKm, suggestionMinItems: 1 },
        });

      expect(attempt(0.1).success).toBe(false); // below the 0.5 floor
      expect(attempt(500).success).toBe(false); // above the 200 ceiling
      expect(attempt(25).success).toBe(true);
    });

    it('requires suggestionMinItems to be an integer >= 1', () => {
      const attempt = (suggestionMinItems: number) =>
        systemSettingsSchema.safeParse({
          ...DEFAULT_SYSTEM_SETTINGS,
          locationGrouping: {
            radiusCaptureEnabled: true,
            maxRadiusKm: 50,
            suggestionMinItems,
          },
        });

      expect(attempt(0).success).toBe(false);
      expect(attempt(1.5).success).toBe(false);
      expect(attempt(5).success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Copy 2 — systemSettingsPatchSchema
  // ---------------------------------------------------------------------------
  describe('copy 2: systemSettingsPatchSchema (all-optional twin)', () => {
    it('accepts a single field in isolation', () => {
      const parsed = systemSettingsPatchSchema.parse({
        locationGrouping: { maxRadiusKm: 25 },
      });
      expect(parsed.locationGrouping).toEqual({ maxRadiusKm: 25 });
    });

    it('still enforces the range', () => {
      expect(
        systemSettingsPatchSchema.safeParse({ locationGrouping: { maxRadiusKm: 9999 } }).success,
      ).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Copy 3 — THE WIRE DTO. This is the one that silently no-ops when forgotten.
  // ---------------------------------------------------------------------------
  describe('copy 3: patchSystemSettingsSchema (the wire DTO)', () => {
    it('does NOT strip the locationGrouping key off the request body', () => {
      const parsed = patchSystemSettingsSchema.parse({
        locationGrouping: { maxRadiusKm: 25 },
      });

      // If the namespace were missing from the wire DTO, nestjs-zod would strip
      // it here and `parsed.locationGrouping` would be undefined — the exact
      // silent no-op this test exists to catch.
      expect(parsed.locationGrouping).toBeDefined();
      expect(parsed.locationGrouping).toEqual({ maxRadiusKm: 25 });
    });

    it('carries every field of the namespace through', () => {
      const parsed = patchSystemSettingsSchema.parse({
        locationGrouping: {
          radiusCaptureEnabled: false,
          maxRadiusKm: 12.5,
          suggestionMinItems: 7,
        },
      });

      expect(parsed.locationGrouping).toEqual({
        radiusCaptureEnabled: false,
        maxRadiusKm: 12.5,
        suggestionMinItems: 7,
      });
    });

    it('rejects an out-of-range value at the wire rather than silently clamping', () => {
      expect(
        patchSystemSettingsSchema.safeParse({ locationGrouping: { maxRadiusKm: 0 } }).success,
      ).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Copy 4 — the service's manual merge + projection
  // ---------------------------------------------------------------------------
  describe('copy 4: SystemSettingsService.patchSettings + getSettings projection', () => {
    let service: SystemSettingsService;
    let mockPrisma: MockPrismaService;

    const mockUserId = 'user-123';
    const mockSystemSettings = {
      id: 'settings-1',
      key: 'global',
      value: DEFAULT_SYSTEM_SETTINGS as never,
      version: 1,
      updatedAt: new Date(),
      updatedByUserId: mockUserId,
      updatedByUser: { id: mockUserId, email: 'admin@example.com' },
    };

    beforeEach(async () => {
      mockPrisma = createMockPrismaService();
      const module: TestingModule = await Test.createTestingModule({
        providers: [SystemSettingsService, { provide: PrismaService, useValue: mockPrisma }],
      }).compile();
      service = module.get<SystemSettingsService>(SystemSettingsService);

      mockPrisma.systemSettings.findUnique.mockResolvedValue(mockSystemSettings as never);
      mockPrisma.auditEvent.create.mockResolvedValue({} as never);
      mockPrisma.systemSettings.update.mockImplementation(((args: {
        data: { value: unknown };
      }) =>
        Promise.resolve({
          ...mockSystemSettings,
          value: args.data.value,
          version: 2,
        })) as never);
    });

    afterEach(() => jest.clearAllMocks());

    it('PATCH { locationGrouping: { maxRadiusKm: 25 } } actually PERSISTS — end to end through the wire DTO', async () => {
      // Drive the value through the REAL wire DTO exactly as a request would.
      const body = patchSystemSettingsSchema.parse({ locationGrouping: { maxRadiusKm: 25 } });

      const result = await service.patchSettings(body as never, mockUserId);

      // 1. It reached the persisted document.
      const persisted = mockPrisma.systemSettings.update.mock.calls[0][0].data
        .value as unknown as { locationGrouping: { maxRadiusKm: number } };
      expect(persisted.locationGrouping.maxRadiusKm).toBe(25);

      // 2. It came back out of the projection (copy 4's second half — a
      //    namespace merged but not projected is stored and never returned).
      expect(result.locationGrouping?.maxRadiusKm).toBe(25);
    });

    it('preserves the untouched fields of the namespace across a partial patch', async () => {
      const body = patchSystemSettingsSchema.parse({
        locationGrouping: { radiusCaptureEnabled: false },
      });

      const result = await service.patchSettings(body as never, mockUserId);

      expect(result.locationGrouping).toEqual({
        radiusCaptureEnabled: false,
        maxRadiusKm: 50,
        suggestionMinItems: 1,
      });
    });

    it('leaves the namespace at its defaults when the patch does not mention it', async () => {
      const body = patchSystemSettingsSchema.parse({ ui: { allowUserThemeOverride: false } });

      const result = await service.patchSettings(body as never, mockUserId);

      expect(result.locationGrouping).toEqual({
        radiusCaptureEnabled: true,
        maxRadiusKm: 50,
        suggestionMinItems: 1,
      });
    });

    it('persists the features.locationGrouping toggle', async () => {
      const body = patchSystemSettingsSchema.parse({ features: { locationGrouping: true } });

      const result = await service.patchSettings(body as never, mockUserId);
      expect(result.features['locationGrouping']).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Feature key + env kill-switch helper
  // ---------------------------------------------------------------------------
  describe('features.locationGrouping + isLocationGroupingEnabled', () => {
    const OLD = process.env['LOCATION_GROUPING_ENABLED'];
    afterEach(() => {
      if (OLD === undefined) delete process.env['LOCATION_GROUPING_ENABLED'];
      else process.env['LOCATION_GROUPING_ENABLED'] = OLD;
    });

    it('is registered in FEATURE_KEYS and defaults to false', () => {
      expect(FEATURE_KEYS.LOCATION_GROUPING).toBe('locationGrouping');
      expect(DEFAULT_SYSTEM_SETTINGS.features['locationGrouping']).toBe(false);
    });

    it('is enabled only when the flag is on and the env kill-switch is not "false"', () => {
      delete process.env['LOCATION_GROUPING_ENABLED'];
      expect(isLocationGroupingEnabled({ features: { locationGrouping: true } })).toBe(true);
      expect(isLocationGroupingEnabled({ features: { locationGrouping: false } })).toBe(false);
      expect(isLocationGroupingEnabled({})).toBe(false);
    });

    it('LOCATION_GROUPING_ENABLED=false overrides an ON flag', () => {
      process.env['LOCATION_GROUPING_ENABLED'] = 'false';
      expect(isLocationGroupingEnabled({ features: { locationGrouping: true } })).toBe(false);
    });

    it('any other env value is NOT an override', () => {
      process.env['LOCATION_GROUPING_ENABLED'] = 'true';
      expect(isLocationGroupingEnabled({ features: { locationGrouping: true } })).toBe(true);
    });
  });
});
