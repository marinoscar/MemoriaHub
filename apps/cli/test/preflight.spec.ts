/**
 * test/preflight.spec.ts
 *
 * Unit tests for runPatPreflight() from src/preflight.ts.
 *
 * We mock chalk and ora (pulled in transitively via ui.ts) to suppress output
 * formatting side-effects, then spy on process.exit and process.stderr.write /
 * process.stdout.write to verify the correct paths are taken.
 *
 * Tests:
 *  1. 401 from GET /api/auth/me → process.exit(1) is called.
 *  2. Non-401 network error     → warning written to stdout, no exit.
 *  3. Token expires in ≤7 days  → warning written to stdout, no exit.
 *  4. Healthy token + far expiry → no output, no exit.
 */

import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Intercept process.exit before any imports so we never actually exit.
// We use a no-op (don't throw) because throwing inside runPatPreflight's catch
// block would be re-caught and swallowed, making it impossible to distinguish
// the 401 path from the generic error path via promise rejection.
// ---------------------------------------------------------------------------
const exitSpy = jest
  .spyOn(process, 'exit')
  .mockImplementation((_code?: string | number | null | undefined) => {
    // intentional no-op — allow tests to verify the call via exitSpy.mock
    return undefined as never;
  });

// ---------------------------------------------------------------------------
// Suppress spinner and chalk colour output
// ---------------------------------------------------------------------------
jest.unstable_mockModule('ora', () => ({
  default: jest.fn(() => ({
    start: jest.fn().mockReturnThis(),
    succeed: jest.fn().mockReturnThis(),
    fail: jest.fn().mockReturnThis(),
    stop: jest.fn().mockReturnThis(),
    text: '',
  })),
}));

jest.unstable_mockModule('chalk', () => ({
  default: new Proxy(
    { level: 0 },
    { get: (_target, prop) => (prop === 'level' ? 0 : (s: string) => s) },
  ),
}));

// Dynamic import AFTER unstable_mockModule registrations
const { runPatPreflight } = await import('../src/preflight.js');
const { ApiError } = await import('../src/api.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FakeApi = {
  get: jest.Mock;
};

function makeFakeApi(opts: { getResult?: unknown; getError?: Error }): FakeApi {
  const getSpy = jest.fn<() => Promise<unknown>>();
  if (opts.getError) {
    getSpy.mockRejectedValue(opts.getError);
  } else {
    getSpy.mockResolvedValue(opts.getResult ?? { email: 'user@example.com' });
  }
  return { get: getSpy };
}

function makeFarFutureConfig() {
  return {
    patExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days out
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPatPreflight', () => {
  let stderrSpy: jest.SpyInstance;
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy.mockClear();
    // Suppress actual output; we'll inspect the calls
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 401 → must exit(1)
  // -------------------------------------------------------------------------

  describe('401 from GET /api/auth/me', () => {
    it('calls process.exit(1)', async () => {
      const api = makeFakeApi({
        getError: new ApiError(401, 'Unauthorized'),
      });

      // NOTE: We cannot use .rejects here because the throw from our no-op
      // mock would be caught by the same catch block in preflight.ts and
      // re-handled as a generic error. Instead we let the call resolve and
      // check the spy directly.
      await runPatPreflight(api as any, makeFarFutureConfig() as any);

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('writes an error message to stderr before calling exit', async () => {
      const api = makeFakeApi({
        getError: new ApiError(401, 'Unauthorized'),
      });

      await runPatPreflight(api as any, makeFarFutureConfig() as any);

      // ui.error writes to stderr — must have fired BEFORE the (mocked) exit call
      const stderrOutput = (stderrSpy.mock.calls as Array<[string]>)
        .map(([s]) => s)
        .join('');
      expect(stderrOutput).toMatch(/invalid|expired|login/i);
    });

    it('does NOT call exit for non-401 API errors', async () => {
      const api = makeFakeApi({ getError: new ApiError(500, 'Server Error') });

      await runPatPreflight(api as any, makeFarFutureConfig() as any);

      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Non-401 network error → warn but proceed (no exit)
  // -------------------------------------------------------------------------

  describe('non-401 error from GET /api/auth/me', () => {
    it('does NOT call process.exit', async () => {
      const api = makeFakeApi({ getError: new Error('ECONNREFUSED') });

      await runPatPreflight(api as any, makeFarFutureConfig() as any);

      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('writes a warning to stdout (non-fatal)', async () => {
      const api = makeFakeApi({ getError: new Error('ECONNREFUSED') });

      await runPatPreflight(api as any, makeFarFutureConfig() as any);

      const stdoutOutput = (stdoutSpy.mock.calls as Array<[string]>)
        .map(([s]) => s)
        .join('');
      expect(stdoutOutput).toMatch(/pre-flight|could not reach|proceeding/i);
    });

    it('resolves (returns undefined) so the command can continue', async () => {
      const api = makeFakeApi({ getError: new Error('500 Server Error') });

      await expect(
        runPatPreflight(api as any, makeFarFutureConfig() as any),
      ).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Token expiring within 7 days → warn but no exit
  // -------------------------------------------------------------------------

  describe('PAT expires within 7 days', () => {
    it('writes an expiry warning to stdout', async () => {
      const api = makeFakeApi({ getResult: { email: 'user@example.com' } });
      const config = {
        patExpiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days
      };

      await runPatPreflight(api as any, config as any);

      const stdoutOutput = (stdoutSpy.mock.calls as Array<[string]>)
        .map(([s]) => s)
        .join('');
      expect(stdoutOutput).toMatch(/expires in \d+ day/i);
    });

    it('does NOT call process.exit when close to expiry', async () => {
      const api = makeFakeApi({ getResult: { email: 'user@example.com' } });
      const config = {
        patExpiresAt: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString(), // 1 day
      };

      await runPatPreflight(api as any, config as any);

      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('resolves without error', async () => {
      const api = makeFakeApi({ getResult: { email: 'user@example.com' } });
      const config = {
        patExpiresAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(), // 6 days
      };

      await expect(
        runPatPreflight(api as any, config as any),
      ).resolves.toBeUndefined();
    });

    it('warns with "1 day" (not "1 days") for singular', async () => {
      const api = makeFakeApi({ getResult: { email: 'user@example.com' } });
      // 1 day from now (20 hours to ensure Math.ceil rounds to 1, not 0)
      const config = {
        patExpiresAt: new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString(),
      };

      await runPatPreflight(api as any, config as any);

      const stdoutOutput = (stdoutSpy.mock.calls as Array<[string]>)
        .map(([s]) => s)
        .join('');
      expect(stdoutOutput).toMatch(/1 day[^s]/);
    });
  });

  // -------------------------------------------------------------------------
  // Token far from expiry → completely silent
  // -------------------------------------------------------------------------

  describe('healthy token with far expiry date', () => {
    it('does NOT call process.exit', async () => {
      const api = makeFakeApi({ getResult: { email: 'user@example.com' } });

      await runPatPreflight(api as any, makeFarFutureConfig() as any);

      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('does NOT write any warnings to stdout', async () => {
      const api = makeFakeApi({ getResult: { email: 'user@example.com' } });

      await runPatPreflight(api as any, makeFarFutureConfig() as any);

      const stdoutOutput = (stdoutSpy.mock.calls as Array<[string]>)
        .map(([s]) => s)
        .join('');
      expect(stdoutOutput).toBe('');
    });

    it('does NOT write anything to stderr', async () => {
      const api = makeFakeApi({ getResult: { email: 'user@example.com' } });

      await runPatPreflight(api as any, makeFarFutureConfig() as any);

      const stderrOutput = (stderrSpy.mock.calls as Array<[string]>)
        .map(([s]) => s)
        .join('');
      expect(stderrOutput).toBe('');
    });

    it('resolves without error', async () => {
      const api = makeFakeApi({ getResult: { email: 'user@example.com' } });

      await expect(
        runPatPreflight(api as any, makeFarFutureConfig() as any),
      ).resolves.toBeUndefined();
    });

    it('is silent when patExpiresAt is absent from config', async () => {
      const api = makeFakeApi({ getResult: { email: 'user@example.com' } });

      await runPatPreflight(api as any, {} as any);

      expect(exitSpy).not.toHaveBeenCalled();
      const stdoutOutput = (stdoutSpy.mock.calls as Array<[string]>)
        .map(([s]) => s)
        .join('');
      expect(stdoutOutput).toBe('');
    });
  });
});
