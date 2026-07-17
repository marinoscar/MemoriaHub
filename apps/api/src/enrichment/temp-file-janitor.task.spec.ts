/**
 * Unit tests for TempFileJanitorTask.
 *
 * The janitor sweeps os.tmpdir() on module init and hourly, deleting files
 * whose name matches /^memoriaHub-/ and whose mtime is older than 6 hours —
 * recovering multi-GB video temp files leaked when a SIGKILL (e.g. kernel OOM)
 * skips the owning handler's finally-block cleanup.
 *
 * Verifies:
 *  - onModuleInit and the hourly cron handler both run a sweep
 *  - old matching files are unlinked (full path under tmpdir())
 *  - young files, non-matching names (prefix is anchored and case-sensitive),
 *    and directories are left alone
 *  - worker mode 'off' (ENRICHMENT_WORKER_MODE=off, or the legacy
 *    ENRICHMENT_WORKER_ENABLED='false' fallback) short-circuits the sweep
 *    entirely; mode 'system' still sweeps (server-only jobs create temp files)
 *  - per-file stat/unlink errors are swallowed and do NOT abort the sweep
 *  - a readdir failure is swallowed (logged) and never throws
 *
 * fs.promises readdir/stat/unlink are replaced with jest mocks; the rest of
 * the real `fs` module is preserved (transitive imports need it to load).
 */

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readdir: jest.fn(),
      stat: jest.fn(),
      unlink: jest.fn(),
    },
  };
});

import { promises as fsPromises } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TempFileJanitorTask } from './temp-file-janitor.task';

const mockReaddir = fsPromises.readdir as unknown as jest.Mock;
const mockStat = fsPromises.stat as unknown as jest.Mock;
const mockUnlink = fsPromises.unlink as unknown as jest.Mock;

const HOUR_MS = 60 * 60 * 1000;

/** Build a Stats-like object aged `ageMs` before now. */
function statOfAge(ageMs: number, isFile = true) {
  return {
    isFile: () => isFile,
    mtimeMs: Date.now() - ageMs,
  };
}

describe('TempFileJanitorTask', () => {
  let task: TempFileJanitorTask;

  const SAVED_WORKER_ENABLED = process.env['ENRICHMENT_WORKER_ENABLED'];
  const SAVED_WORKER_MODE = process.env['ENRICHMENT_WORKER_MODE'];

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env['ENRICHMENT_WORKER_ENABLED'];
    delete process.env['ENRICHMENT_WORKER_MODE'];

    // Defaults: empty dir, everything old, unlink succeeds.
    mockReaddir.mockResolvedValue([]);
    mockStat.mockResolvedValue(statOfAge(7 * HOUR_MS));
    mockUnlink.mockResolvedValue(undefined);

    task = new TempFileJanitorTask();
  });

  afterEach(() => {
    if (SAVED_WORKER_ENABLED === undefined) {
      delete process.env['ENRICHMENT_WORKER_ENABLED'];
    } else {
      process.env['ENRICHMENT_WORKER_ENABLED'] = SAVED_WORKER_ENABLED;
    }
    if (SAVED_WORKER_MODE === undefined) {
      delete process.env['ENRICHMENT_WORKER_MODE'];
    } else {
      process.env['ENRICHMENT_WORKER_MODE'] = SAVED_WORKER_MODE;
    }
  });

  // ---------------------------------------------------------------------------
  // Triggers: startup sweep + hourly cron
  // ---------------------------------------------------------------------------

  describe('sweep triggers', () => {
    it('onModuleInit runs a startup sweep over os.tmpdir()', async () => {
      await task.onModuleInit();

      expect(mockReaddir).toHaveBeenCalledTimes(1);
      expect(mockReaddir).toHaveBeenCalledWith(tmpdir());
    });

    it('the hourly cron handler also runs a sweep', async () => {
      await task.handleSweep();

      expect(mockReaddir).toHaveBeenCalledTimes(1);
      expect(mockReaddir).toHaveBeenCalledWith(tmpdir());
    });
  });

  // ---------------------------------------------------------------------------
  // Deletion policy
  // ---------------------------------------------------------------------------

  describe('deletion policy', () => {
    it('deletes memoriaHub-* files older than 6 hours (full path under tmpdir)', async () => {
      mockReaddir.mockResolvedValue([
        'memoriaHub-vface-dl-abc.mp4',
        'memoriaHub-social-dl-def.mov',
      ]);
      mockStat.mockResolvedValue(statOfAge(7 * HOUR_MS));

      await task.handleSweep();

      expect(mockUnlink).toHaveBeenCalledTimes(2);
      expect(mockUnlink).toHaveBeenCalledWith(join(tmpdir(), 'memoriaHub-vface-dl-abc.mp4'));
      expect(mockUnlink).toHaveBeenCalledWith(join(tmpdir(), 'memoriaHub-social-dl-def.mov'));
    });

    it('keeps matching files younger than 6 hours', async () => {
      mockReaddir.mockResolvedValue(['memoriaHub-vface-dl-young.mp4']);
      mockStat.mockResolvedValue(statOfAge(1 * HOUR_MS));

      await task.handleSweep();

      expect(mockStat).toHaveBeenCalledTimes(1);
      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it('ignores names without the memoriaHub- prefix (never even stats them)', async () => {
      mockReaddir.mockResolvedValue([
        'random-file.tmp',
        'MemoriaHub-case-mismatch.mp4', // prefix is case-sensitive
        'not-memoriaHub-anchored.mp4', // prefix is anchored at the start
        'systemd-private-xyz',
      ]);

      await task.handleSweep();

      expect(mockStat).not.toHaveBeenCalled();
      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it('skips directories even when the name matches and is old', async () => {
      mockReaddir.mockResolvedValue(['memoriaHub-weird-dir']);
      mockStat.mockResolvedValue(statOfAge(10 * HOUR_MS, false));

      await task.handleSweep();

      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it('mixed listing: only old, matching regular files are removed', async () => {
      mockReaddir.mockResolvedValue([
        'memoriaHub-old.mp4', // old + matching → deleted
        'memoriaHub-young.mp4', // young → kept
        'unrelated-old.mp4', // non-matching → ignored
      ]);
      mockStat
        .mockResolvedValueOnce(statOfAge(8 * HOUR_MS)) // memoriaHub-old.mp4
        .mockResolvedValueOnce(statOfAge(1 * HOUR_MS)); // memoriaHub-young.mp4

      await task.handleSweep();

      expect(mockStat).toHaveBeenCalledTimes(2); // unrelated file never statted
      expect(mockUnlink).toHaveBeenCalledTimes(1);
      expect(mockUnlink).toHaveBeenCalledWith(join(tmpdir(), 'memoriaHub-old.mp4'));
    });
  });

  // ---------------------------------------------------------------------------
  // Disable flag
  // ---------------------------------------------------------------------------

  describe('worker mode gating (only mode "off" skips)', () => {
    it('skips the sweep entirely (no readdir) when the legacy ENRICHMENT_WORKER_ENABLED=false maps to mode off', async () => {
      process.env['ENRICHMENT_WORKER_ENABLED'] = 'false';

      await task.handleSweep();

      expect(mockReaddir).not.toHaveBeenCalled();
      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it('skips the sweep when ENRICHMENT_WORKER_MODE=off', async () => {
      process.env['ENRICHMENT_WORKER_MODE'] = 'off';

      await task.handleSweep();

      expect(mockReaddir).not.toHaveBeenCalled();
      expect(mockUnlink).not.toHaveBeenCalled();
    });

    it('also skips the startup sweep from onModuleInit', async () => {
      process.env['ENRICHMENT_WORKER_ENABLED'] = 'false';

      await task.onModuleInit();

      expect(mockReaddir).not.toHaveBeenCalled();
    });

    it('STILL sweeps in system mode — server-only jobs create temp files too', async () => {
      process.env['ENRICHMENT_WORKER_MODE'] = 'system';

      await task.handleSweep();

      expect(mockReaddir).toHaveBeenCalledTimes(1);
    });

    it('system mode sweeps even when the legacy var says false (explicit mode wins)', async () => {
      process.env['ENRICHMENT_WORKER_MODE'] = 'system';
      process.env['ENRICHMENT_WORKER_ENABLED'] = 'false';

      await task.handleSweep();

      expect(mockReaddir).toHaveBeenCalledTimes(1);
    });

    it('is strict equality — legacy "true" (or anything else) still sweeps', async () => {
      process.env['ENRICHMENT_WORKER_ENABLED'] = 'true';

      await task.handleSweep();

      expect(mockReaddir).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Error resilience (best-effort sweep)
  // ---------------------------------------------------------------------------

  describe('error resilience', () => {
    it('a stat failure on one file does not abort the sweep of the remaining files', async () => {
      mockReaddir.mockResolvedValue([
        'memoriaHub-gone.mp4', // stat throws (e.g. unlinked by its owning job)
        'memoriaHub-old-1.mp4',
        'memoriaHub-old-2.mp4',
      ]);
      mockStat
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValueOnce(statOfAge(7 * HOUR_MS))
        .mockResolvedValueOnce(statOfAge(7 * HOUR_MS));

      await expect(task.handleSweep()).resolves.toBeUndefined();

      expect(mockUnlink).toHaveBeenCalledTimes(2);
      expect(mockUnlink).toHaveBeenCalledWith(join(tmpdir(), 'memoriaHub-old-1.mp4'));
      expect(mockUnlink).toHaveBeenCalledWith(join(tmpdir(), 'memoriaHub-old-2.mp4'));
    });

    it('an unlink failure on one file does not abort the sweep of the remaining files', async () => {
      mockReaddir.mockResolvedValue(['memoriaHub-locked.mp4', 'memoriaHub-ok.mp4']);
      mockStat.mockResolvedValue(statOfAge(7 * HOUR_MS));
      mockUnlink
        .mockRejectedValueOnce(new Error('EACCES: permission denied'))
        .mockResolvedValueOnce(undefined);

      await expect(task.handleSweep()).resolves.toBeUndefined();

      // Both deletions were ATTEMPTED; the first failure was swallowed.
      expect(mockUnlink).toHaveBeenCalledTimes(2);
      expect(mockUnlink).toHaveBeenCalledWith(join(tmpdir(), 'memoriaHub-ok.mp4'));
    });

    it('a readdir failure is swallowed (logged) — the sweep never throws', async () => {
      const loggerErrorSpy = jest
        .spyOn((task as any).logger, 'error')
        .mockImplementation(() => {});
      mockReaddir.mockRejectedValue(new Error('EIO: disk error'));

      await expect(task.handleSweep()).resolves.toBeUndefined();

      expect(mockUnlink).not.toHaveBeenCalled();
      expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    });
  });
});
