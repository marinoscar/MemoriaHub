/**
 * Unit tests for AdminMemoriesController (epic #300, issue #315).
 *
 * The controller is deliberately thin, so exactly two things are worth testing:
 * the feature gate (400 before anything is enqueued, folding in the
 * MEMORIES_ENABLED env kill-switch) and the `{ data: … }` envelope the sibling
 * admin backfills use.
 *
 * The guard matrix itself (Admin role + system_settings:write) is enforced by
 * the @MemoriahubAuth decorator and asserted at the metadata level below rather
 * than by standing up the whole Nest HTTP stack — the same approach the other
 * admin controllers' specs take.
 */

import { BadRequestException } from '@nestjs/common';
import { AdminMemoriesController } from '../../../src/memories/admin/admin-memories.controller.js';
import { MemoryBackfillService } from '../../../src/memories/admin/memory-backfill.service.js';
import { MEMORIAHUB_PERMISSIONS_KEY, MEMORIAHUB_ROLES_KEY } from '../../../src/core/index.js';
import { MemoriesSettingsService } from '../../../src/memories/memories-settings.util.js';
import { settingsPortFrom } from '../../helpers/settings-port.js';

describe('AdminMemoriesController', () => {
  let controller: AdminMemoriesController;
  let backfill: { backfillLibrary: jest.Mock };
  let document: Record<string, unknown>;

  const originalEnv = process.env['MEMORIES_ENABLED'];

  beforeEach(async () => {
    backfill = {
      backfillLibrary: jest.fn().mockResolvedValue({ enqueued: 18, circles: 1, skipped: 0 }),
    };
    document = { features: { memories: true } };
    delete process.env['MEMORIES_ENABLED'];

    // Constructed directly rather than through Test.createTestingModule: the
    // class carries @MemoriahubAuth, whose guard Nest would try to instantiate for
    // a controller whose logic is two awaits. The guard wiring is asserted at the
    // metadata level below instead.
    controller = new AdminMemoriesController(
      backfill as unknown as MemoryBackfillService,
      new MemoriesSettingsService(settingsPortFrom(() => document) as never, { digest: { signingKey: () => Buffer.alloc(32) } }),
    );
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['MEMORIES_ENABLED'];
    else process.env['MEMORIES_ENABLED'] = originalEnv;
  });

  // -------------------------------------------------------------------------
  describe('feature gate', () => {
    it('400s and enqueues nothing when features.memories is off', async () => {
      document = { features: { memories: false } };

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
      document = {};

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
      const roles = Reflect.getMetadata(MEMORIAHUB_ROLES_KEY, handler);
      const permissions = Reflect.getMetadata(MEMORIAHUB_PERMISSIONS_KEY, handler);

      expect(roles).toEqual(['admin']);
      expect(permissions).toEqual(['system_settings:write']);
    });
  });
});
