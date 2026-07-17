/**
 * Unit tests for EnrichmentStuckResetTask.handleStuckReset.
 *
 * Verifies:
 *  - resetStuck is called with NO argument — the threshold is resolved inside
 *    EnrichmentAdminService from the jobs.stuckThresholdMinutes system setting
 *    (falling back to the legacy ENRICHMENT_STUCK_MINUTES env var), not parsed
 *    here in the cron.
 *  - The reaper is DECOUPLED from the worker switches: it still runs when
 *    ENRICHMENT_WORKER_ENABLED='false' or ENRICHMENT_WORKER_MODE='off' —
 *    it is a control-plane duty external node fleets depend on (lease-expiry
 *    reaping), not a worker duty.
 *  - The only opt-out is the dedicated ENRICHMENT_REAPER_ENABLED='false' flag.
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
  const SAVED_WORKER_MODE = process.env['ENRICHMENT_WORKER_MODE'];
  const SAVED_REAPER_ENABLED = process.env['ENRICHMENT_REAPER_ENABLED'];
  const SAVED_STUCK_MINUTES = process.env['ENRICHMENT_STUCK_MINUTES'];

  beforeEach(async () => {
    // resetStuck now returns { reset, failed } — failed counts stuck jobs whose
    // claim-time-charged attempts budget was exhausted (marked failed, not requeued).
    resetStuck = jest.fn().mockResolvedValue({ reset: 0, failed: 0 });

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
    const restore = (key: string, saved: string | undefined) => {
      if (saved === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved;
      }
    };
    restore('ENRICHMENT_WORKER_ENABLED', SAVED_WORKER_ENABLED);
    restore('ENRICHMENT_WORKER_MODE', SAVED_WORKER_MODE);
    restore('ENRICHMENT_REAPER_ENABLED', SAVED_REAPER_ENABLED);
    restore('ENRICHMENT_STUCK_MINUTES', SAVED_STUCK_MINUTES);
  });

  // -------------------------------------------------------------------------
  // Default behavior
  // -------------------------------------------------------------------------

  describe('reaper enabled (default)', () => {
    it('calls resetStuck() with no argument regardless of ENRICHMENT_STUCK_MINUTES', async () => {
      delete process.env['ENRICHMENT_REAPER_ENABLED'];
      delete process.env['ENRICHMENT_STUCK_MINUTES'];

      await task.handleStuckReset();

      expect(resetStuck).toHaveBeenCalledTimes(1);
      expect(resetStuck).toHaveBeenCalledWith();
    });

    it('still calls resetStuck() with no argument when ENRICHMENT_STUCK_MINUTES=30 (env no longer parsed here)', async () => {
      delete process.env['ENRICHMENT_REAPER_ENABLED'];
      process.env['ENRICHMENT_STUCK_MINUTES'] = '30';

      await task.handleStuckReset();

      expect(resetStuck).toHaveBeenCalledWith();
    });

    it('does not pass any arguments to resetStuck — length of the call args array is 0', async () => {
      delete process.env['ENRICHMENT_REAPER_ENABLED'];

      await task.handleStuckReset();

      expect(resetStuck.mock.calls[0]).toHaveLength(0);
    });

    it('does not throw when resetStuck returns { reset: 0, failed: 0 }', async () => {
      resetStuck.mockResolvedValue({ reset: 0, failed: 0 });

      await expect(task.handleStuckReset()).resolves.toBeUndefined();
    });

    it('does not throw when resetStuck reports reset jobs only', async () => {
      resetStuck.mockResolvedValue({ reset: 3, failed: 0 });

      await expect(task.handleStuckReset()).resolves.toBeUndefined();
    });

    it('does not throw when resetStuck reports exhausted-attempts jobs marked failed', async () => {
      resetStuck.mockResolvedValue({ reset: 2, failed: 1 });

      await expect(task.handleStuckReset()).resolves.toBeUndefined();
      expect(resetStuck).toHaveBeenCalledTimes(1);
    });

    it('does not throw when only failed jobs are reported (reset: 0, failed > 0)', async () => {
      resetStuck.mockResolvedValue({ reset: 0, failed: 4 });

      await expect(task.handleStuckReset()).resolves.toBeUndefined();
    });

    it('does not throw when resetStuck rejects (error is caught internally)', async () => {
      resetStuck.mockRejectedValue(new Error('DB connection lost'));

      await expect(task.handleStuckReset()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Decoupled from the worker switches — control-plane duty
  // -------------------------------------------------------------------------

  describe('decoupled from the enrichment worker switches', () => {
    it('STILL calls resetStuck when ENRICHMENT_WORKER_ENABLED=false (lease reaper must run on control-plane instances)', async () => {
      process.env['ENRICHMENT_WORKER_ENABLED'] = 'false';
      delete process.env['ENRICHMENT_REAPER_ENABLED'];

      await task.handleStuckReset();

      expect(resetStuck).toHaveBeenCalledTimes(1);
    });

    it('STILL calls resetStuck when ENRICHMENT_WORKER_MODE=off', async () => {
      process.env['ENRICHMENT_WORKER_MODE'] = 'off';
      delete process.env['ENRICHMENT_REAPER_ENABLED'];

      await task.handleStuckReset();

      expect(resetStuck).toHaveBeenCalledTimes(1);
    });

    it('STILL calls resetStuck when ENRICHMENT_WORKER_MODE=system', async () => {
      process.env['ENRICHMENT_WORKER_MODE'] = 'system';
      delete process.env['ENRICHMENT_REAPER_ENABLED'];

      await task.handleStuckReset();

      expect(resetStuck).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Dedicated opt-out
  // -------------------------------------------------------------------------

  describe('reaper disabled (ENRICHMENT_REAPER_ENABLED=false)', () => {
    it('does NOT call resetStuck', async () => {
      process.env['ENRICHMENT_REAPER_ENABLED'] = 'false';

      await task.handleStuckReset();

      expect(resetStuck).not.toHaveBeenCalled();
    });

    it('returns without error', async () => {
      process.env['ENRICHMENT_REAPER_ENABLED'] = 'false';

      await expect(task.handleStuckReset()).resolves.toBeUndefined();
    });

    it('is case-sensitive — "False" (capital F) does not skip', async () => {
      // The implementation checks strict equality to 'false', so 'False' is not skipped
      process.env['ENRICHMENT_REAPER_ENABLED'] = 'False';

      await task.handleStuckReset();

      // 'False' !== 'false', so resetStuck IS called
      expect(resetStuck).toHaveBeenCalled();
    });
  });
});
