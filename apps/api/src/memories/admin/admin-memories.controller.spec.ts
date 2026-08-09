/**
 * Unit tests for AdminMemoriesController (epic #300, issue #315).
 *
 * The controller is deliberately thin, so exactly two things are worth testing:
 * the feature gate (400 before anything is enqueued, folding in the
 * MEMORIES_ENABLED env kill-switch) and the `{ data: … }` envelope the sibling
 * admin backfills use.
 *
 * The guard matrix itself (Admin role + system_settings:write) is enforced by
 * the shared @Auth decorator and asserted at the metadata level below rather
 * than by standing up the whole Nest HTTP stack — the same approach the other
 * admin controllers' specs take.
 */

import { BadRequestException } from '@nestjs/common';
import { AdminMemoriesController } from './admin-memories.controller';
import { MemoryBackfillService } from './memory-backfill.service';
import { SystemSettingsService } from '../../settings/system-settings/system-settings.service';
import { PERMISSIONS, ROLES } from '../../common/constants/roles.constants';

describe('AdminMemoriesController', () => {
  let controller: AdminMemoriesController;
  let backfill: { backfillLibrary: jest.Mock };
  let settings: { getSettings: jest.Mock };

  const originalEnv = process.env['MEMORIES_ENABLED'];

  beforeEach(async () => {
    backfill = {
      backfillLibrary: jest.fn().mockResolvedValue({ enqueued: 18, circles: 1, skipped: 0 }),
    };
    settings = {
      getSettings: jest.fn().mockResolvedValue({ features: { memories: true } }),
    };
    delete process.env['MEMORIES_ENABLED'];

    // Constructed directly rather than through Test.createTestingModule: the
    // class carries @Auth, whose guards Nest would try to instantiate (and
    // whose own dependency graph reaches the whole auth module) for a
    // controller whose logic is two awaits. The guard wiring is asserted at the
    // metadata level below instead.
    controller = new AdminMemoriesController(
      backfill as unknown as MemoryBackfillService,
      settings as unknown as SystemSettingsService,
    );
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['MEMORIES_ENABLED'];
    else process.env['MEMORIES_ENABLED'] = originalEnv;
  });

  // -------------------------------------------------------------------------
  describe('feature gate', () => {
    it('400s and enqueues nothing when features.memories is off', async () => {
      settings.getSettings.mockResolvedValue({ features: { memories: false } });

      await expect(controller.backfill({} as never)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(backfill.backfillLibrary).not.toHaveBeenCalled();
    });

    it('400s when the settings flag is on but MEMORIES_ENABLED=false', async () => {
      process.env['MEMORIES_ENABLED'] = 'false';

      await expect(controller.backfill({} as never)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(backfill.backfillLibrary).not.toHaveBeenCalled();
    });

    it('400s when the features record is absent entirely', async () => {
      settings.getSettings.mockResolvedValue({});

      await expect(controller.backfill({} as never)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('enqueue', () => {
    it('sweeps every circle when no circleId is given', async () => {
      const response = await controller.backfill({} as never);

      expect(backfill.backfillLibrary).toHaveBeenCalledWith({});
      expect(response).toEqual({ data: { enqueued: 18, circles: 1, skipped: 0 } });
    });

    it('scopes the sweep to one circle when circleId is given', async () => {
      await controller.backfill({ circleId: 'circle-a' } as never);

      expect(backfill.backfillLibrary).toHaveBeenCalledWith({ circleId: 'circle-a' });
    });
  });

  // -------------------------------------------------------------------------
  describe('RBAC metadata', () => {
    it('requires the Admin role and system_settings:write', () => {
      const handler = AdminMemoriesController.prototype.backfill;
      const roles = Reflect.getMetadata('roles', handler);
      const permissions = Reflect.getMetadata('permissions', handler);

      expect(roles).toEqual([ROLES.ADMIN]);
      expect(permissions).toEqual([PERMISSIONS.SYSTEM_SETTINGS_WRITE]);
    });
  });
});
