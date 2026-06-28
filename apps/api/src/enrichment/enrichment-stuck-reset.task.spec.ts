/**
 * Unit tests for EnrichmentStuckResetTask.handleStuckReset.
 *
 * Verifies:
 *  - When the worker is enabled: resetStuck is called with the default
 *    threshold (15 min) or with the value from ENRICHMENT_STUCK_MINUTES.
 *  - When ENRICHMENT_WORKER_ENABLED='false': resetStuck is NOT called.
 *
 * Env vars are saved/restored around each test so they don't leak.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EnrichmentStuckResetTask } from './enrichment-stuck-reset.task';
import { EnrichmentAdminService } from './enrichment-admin.service';

describe('EnrichmentStuckResetTask', () => {
  let task: EnrichmentStuckResetTask;
  let resetStuck: jest.Mock;

  // Capture env values before the suite runs so we can restore them
  const SAVED_WORKER_ENABLED = process.env['ENRICHMENT_WORKER_ENABLED'];
  const SAVED_STUCK_MINUTES = process.env['ENRICHMENT_STUCK_MINUTES'];

  beforeEach(async () => {
    resetStuck = jest.fn().mockResolvedValue({ reset: 0 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnrichmentStuckResetTask,
        {
          provide: EnrichmentAdminService,
          useValue: { resetStuck },
        },
      ],
    }).compile();

    task = module.get<EnrichmentStuckResetTask>(EnrichmentStuckResetTask);
  });

  afterEach(() => {
    // Restore env vars to their pre-test state
    if (SAVED_WORKER_ENABLED === undefined) {
      delete process.env['ENRICHMENT_WORKER_ENABLED'];
    } else {
      process.env['ENRICHMENT_WORKER_ENABLED'] = SAVED_WORKER_ENABLED;
    }
    if (SAVED_STUCK_MINUTES === undefined) {
      delete process.env['ENRICHMENT_STUCK_MINUTES'];
    } else {
      process.env['ENRICHMENT_STUCK_MINUTES'] = SAVED_STUCK_MINUTES;
    }
  });

  // -------------------------------------------------------------------------
  // Worker enabled (default)
  // -------------------------------------------------------------------------

  describe('worker enabled', () => {
    it('calls resetStuck(15) by default when ENRICHMENT_STUCK_MINUTES is not set', async () => {
      delete process.env['ENRICHMENT_WORKER_ENABLED'];
      delete process.env['ENRICHMENT_STUCK_MINUTES'];

      await task.handleStuckReset();

      expect(resetStuck).toHaveBeenCalledTimes(1);
      expect(resetStuck).toHaveBeenCalledWith(15);
    });

    it('calls resetStuck(N) when ENRICHMENT_STUCK_MINUTES=N', async () => {
      delete process.env['ENRICHMENT_WORKER_ENABLED'];
      process.env['ENRICHMENT_STUCK_MINUTES'] = '30';

      await task.handleStuckReset();

      expect(resetStuck).toHaveBeenCalledWith(30);
    });

    it('calls resetStuck(60) when ENRICHMENT_STUCK_MINUTES=60', async () => {
      delete process.env['ENRICHMENT_WORKER_ENABLED'];
      process.env['ENRICHMENT_STUCK_MINUTES'] = '60';

      await task.handleStuckReset();

      expect(resetStuck).toHaveBeenCalledWith(60);
    });

    it('uses default 15 when ENRICHMENT_WORKER_ENABLED is not "false"', async () => {
      process.env['ENRICHMENT_WORKER_ENABLED'] = 'true';
      delete process.env['ENRICHMENT_STUCK_MINUTES'];

      await task.handleStuckReset();

      expect(resetStuck).toHaveBeenCalledWith(15);
    });

    it('does not throw when resetStuck returns { reset: 0 }', async () => {
      delete process.env['ENRICHMENT_WORKER_ENABLED'];
      resetStuck.mockResolvedValue({ reset: 0 });

      await expect(task.handleStuckReset()).resolves.toBeUndefined();
    });

    it('does not throw when resetStuck rejects (error is caught internally)', async () => {
      delete process.env['ENRICHMENT_WORKER_ENABLED'];
      resetStuck.mockRejectedValue(new Error('DB connection lost'));

      await expect(task.handleStuckReset()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Worker explicitly disabled
  // -------------------------------------------------------------------------

  describe('worker disabled (ENRICHMENT_WORKER_ENABLED=false)', () => {
    it('does NOT call resetStuck', async () => {
      process.env['ENRICHMENT_WORKER_ENABLED'] = 'false';

      await task.handleStuckReset();

      expect(resetStuck).not.toHaveBeenCalled();
    });

    it('returns without error', async () => {
      process.env['ENRICHMENT_WORKER_ENABLED'] = 'false';

      await expect(task.handleStuckReset()).resolves.toBeUndefined();
    });

    it('is case-sensitive — "False" (capital F) does not skip', async () => {
      // The implementation checks strict equality to 'false', so 'False' is not skipped
      process.env['ENRICHMENT_WORKER_ENABLED'] = 'False';

      await task.handleStuckReset();

      // 'False' !== 'false', so resetStuck IS called
      expect(resetStuck).toHaveBeenCalled();
    });
  });
});
