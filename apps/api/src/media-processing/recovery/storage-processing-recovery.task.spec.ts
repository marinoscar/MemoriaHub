/**
 * Unit tests for StorageProcessingRecoveryTask.handleStuckRecovery.
 *
 * Mirrors enrichment-stuck-reset.task.spec.ts:
 *  - Delegates to StorageProcessingRecoveryService.recoverStuckObjects()
 *    with no explicit threshold (the service resolves its own env default).
 *  - When STORAGE_PROCESSING_STUCK_RESET_ENABLED='false': the service is NOT called.
 *  - Never throws, even if the service rejects.
 *
 * Env vars are saved/restored around each test so they don't leak.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { StorageProcessingRecoveryTask } from './storage-processing-recovery.task';
import { StorageProcessingRecoveryService } from './storage-processing-recovery.service';

describe('StorageProcessingRecoveryTask', () => {
  let task: StorageProcessingRecoveryTask;
  let recoverStuckObjects: jest.Mock;

  const SAVED_ENABLED = process.env['STORAGE_PROCESSING_STUCK_RESET_ENABLED'];

  beforeEach(async () => {
    recoverStuckObjects = jest.fn().mockResolvedValue({ claimed: 0, reprocessed: 0, exhausted: 0, errors: 0 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StorageProcessingRecoveryTask,
        {
          provide: StorageProcessingRecoveryService,
          useValue: { recoverStuckObjects },
        },
      ],
    }).compile();

    task = module.get<StorageProcessingRecoveryTask>(StorageProcessingRecoveryTask);
  });

  afterEach(() => {
    if (SAVED_ENABLED === undefined) {
      delete process.env['STORAGE_PROCESSING_STUCK_RESET_ENABLED'];
    } else {
      process.env['STORAGE_PROCESSING_STUCK_RESET_ENABLED'] = SAVED_ENABLED;
    }
  });

  describe('enabled (default)', () => {
    it('calls recoverStuckObjects() when the env flag is unset', async () => {
      delete process.env['STORAGE_PROCESSING_STUCK_RESET_ENABLED'];

      await task.handleStuckRecovery();

      expect(recoverStuckObjects).toHaveBeenCalledTimes(1);
      expect(recoverStuckObjects).toHaveBeenCalledWith();
    });

    it('calls recoverStuckObjects() when the env flag is "true"', async () => {
      process.env['STORAGE_PROCESSING_STUCK_RESET_ENABLED'] = 'true';

      await task.handleStuckRecovery();

      expect(recoverStuckObjects).toHaveBeenCalledTimes(1);
    });

    it('does not throw when recoverStuckObjects resolves with all zeros', async () => {
      delete process.env['STORAGE_PROCESSING_STUCK_RESET_ENABLED'];
      recoverStuckObjects.mockResolvedValue({ claimed: 0, reprocessed: 0, exhausted: 0, errors: 0 });

      await expect(task.handleStuckRecovery()).resolves.toBeUndefined();
    });

    it('does not throw when recoverStuckObjects rejects (error is caught internally)', async () => {
      delete process.env['STORAGE_PROCESSING_STUCK_RESET_ENABLED'];
      recoverStuckObjects.mockRejectedValue(new Error('DB connection lost'));

      await expect(task.handleStuckRecovery()).resolves.toBeUndefined();
    });
  });

  describe('disabled (STORAGE_PROCESSING_STUCK_RESET_ENABLED=false)', () => {
    it('does NOT call recoverStuckObjects', async () => {
      process.env['STORAGE_PROCESSING_STUCK_RESET_ENABLED'] = 'false';

      await task.handleStuckRecovery();

      expect(recoverStuckObjects).not.toHaveBeenCalled();
    });

    it('returns without error', async () => {
      process.env['STORAGE_PROCESSING_STUCK_RESET_ENABLED'] = 'false';

      await expect(task.handleStuckRecovery()).resolves.toBeUndefined();
    });
  });
});
