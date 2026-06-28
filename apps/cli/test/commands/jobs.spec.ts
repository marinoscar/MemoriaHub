/**
 * test/commands/jobs.spec.ts — Unit tests for the `jobs` command.
 *
 * Tests:
 *   - --json: calls getJobInsights, prints JSON to stdout, exits 0
 *   - --json: 403 ApiError → error message + exit(1)
 *   - --json: generic error → error message + exit(1)
 *   - --once: calls getJobInsights, writes header + KPI line + table, exits 0
 *   - --once: 403 ApiError → error message + exit(1)
 *   - --window: passes parsed windowDays to getJobInsights
 *
 * Mocking strategy: jest.unstable_mockModule for config and ApiClient (ESM).
 * process.exit is intercepted to throw so Jest does not actually exit.
 * process.stdout.write is spied on to capture output.
 * console.log is spied on to capture JSON output.
 */

import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Intercept process.exit so Jest does not actually exit
// ---------------------------------------------------------------------------
const mockExit = jest.spyOn(process, 'exit').mockImplementation((_code?: number) => {
  throw new Error(`process.exit(${String(_code)})`);
});

// ---------------------------------------------------------------------------
// Suppress chalk/ui color output for consistent assertions
// ---------------------------------------------------------------------------
process.env['NO_COLOR'] = '1';

// ---------------------------------------------------------------------------
// Mock config module
// ---------------------------------------------------------------------------
const mockRequireConfig = jest.fn(() => ({
  serverUrl: 'http://test-server',
  pat: 'test-pat',
}));

jest.unstable_mockModule('../../src/config.js', () => ({
  requireConfig: mockRequireConfig,
  loadConfig: jest.fn(),
  saveConfig: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Mock ui module
// ---------------------------------------------------------------------------
const mockUiError = jest.fn();

jest.unstable_mockModule('../../src/ui.js', () => ({
  ui: { error: mockUiError },
  isTTY: false, // force non-TTY so TUI branch is skipped
}));

// ---------------------------------------------------------------------------
// Mock ApiClient
// ---------------------------------------------------------------------------
const mockGetJobInsights = jest.fn<() => Promise<import('../../src/api.js').JobInsights>>();

jest.unstable_mockModule('../../src/api.js', () => {
  const ApiClient = jest.fn().mockImplementation(() => ({
    getJobInsights: mockGetJobInsights,
  }));
  return {
    ApiClient,
    ApiError: class ApiError extends Error {
      public status: number;
      public serverMessage: string;
      constructor(status: number, serverMessage: string) {
        super(`API error ${status}: ${serverMessage}`);
        this.name = 'ApiError';
        this.status = status;
        this.serverMessage = serverMessage;
      }
    },
  };
});

// Dynamic import AFTER all unstable_mockModule calls
const { jobsCommand } = await import('../../src/commands/jobs.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSampleInsights(overrides: Partial<import('../../src/api.js').JobInsights> = {}): import('../../src/api.js').JobInsights {
  return {
    computedAt: new Date().toISOString(),
    windowDays: 7,
    concurrency: 1,
    live: {
      total: 10,
      byStatus: { pending: 3, running: 1, succeeded: 5, failed: 1 },
      pending: 3,
      running: 1,
      failed: 1,
      scheduled: 0,
      rateLimited: 0,
      retried: 2,
      byType: [
        { type: 'face_detection', pending: 3, running: 1, succeeded: 5, failed: 1, total: 10 },
      ],
    },
    history: {
      overall: { samples: 100, avgMs: 2000, p50Ms: 1800, p95Ms: 4500, throughputPerMin: 1.5 },
      byType: [
        { type: 'face_detection', samples: 100, avgMs: 2000, p50Ms: 1800, p95Ms: 4500, throughputPerMin: 1.5 },
      ],
    },
    eta: {
      totalRemaining: 4,
      etaMs: 8000,
      basis: 'live',
      perType: [
        { type: 'face_detection', remaining: 4, avgMs: 2000, etcMs: 8000 },
      ],
    },
    ...overrides,
  };
}

/**
 * Run the jobs command via commander.parseAsync.
 * Resolves if the command completes normally, rejects if process.exit() was called.
 */
async function invokeJobs(args: string[]): Promise<void> {
  const cmd = jobsCommand();
  await cmd.parseAsync(['node', 'memoriahub', ...args]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('jobs command', () => {
  let stdoutSpy: ReturnType<typeof jest.spyOn>;
  let consoleSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRequireConfig.mockReturnValue({ serverUrl: 'http://test-server', pat: 'test-pat' });
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  afterAll(() => {
    mockExit.mockRestore();
  });

  // =========================================================================
  // --json mode
  // =========================================================================

  describe('--json mode', () => {
    it('calls getJobInsights with default windowDays=7', async () => {
      mockGetJobInsights.mockResolvedValue(makeSampleInsights());

      await invokeJobs(['--json']).catch(() => {});

      expect(mockGetJobInsights).toHaveBeenCalledWith(7);
    });

    it('prints JSON to stdout via console.log', async () => {
      const insights = makeSampleInsights();
      mockGetJobInsights.mockResolvedValue(insights);

      await invokeJobs(['--json']).catch(() => {});

      const printed = consoleSpy.mock.calls.map((c) => c[0]).join('');
      const parsed = JSON.parse(printed) as typeof insights;
      expect(parsed.windowDays).toBe(7);
      expect(parsed.live.total).toBe(10);
    });

    it('exits with 0 after printing JSON', async () => {
      mockGetJobInsights.mockResolvedValue(makeSampleInsights());

      await expect(invokeJobs(['--json'])).rejects.toThrow('process.exit(0)');
    });

    it('calls requireConfig to get credentials', async () => {
      mockGetJobInsights.mockResolvedValue(makeSampleInsights());

      await invokeJobs(['--json']).catch(() => {});

      expect(mockRequireConfig).toHaveBeenCalled();
    });

    it('shows permission error and exits 1 on 403 ApiError', async () => {
      const { ApiError } = await import('../../src/api.js');
      mockGetJobInsights.mockRejectedValue(new ApiError(403, 'Forbidden'));

      await expect(invokeJobs(['--json'])).rejects.toThrow('process.exit(1)');
      expect(mockUiError).toHaveBeenCalledWith(
        expect.stringContaining('admin access token'),
      );
    });

    it('shows generic error and exits 1 on other errors', async () => {
      mockGetJobInsights.mockRejectedValue(new Error('Network timeout'));

      await expect(invokeJobs(['--json'])).rejects.toThrow('process.exit(1)');
      expect(mockUiError).toHaveBeenCalledWith(
        expect.stringContaining('Network timeout'),
      );
    });
  });

  // =========================================================================
  // --once mode (headless snapshot)
  // =========================================================================

  describe('--once mode', () => {
    it('calls getJobInsights with default windowDays=7', async () => {
      mockGetJobInsights.mockResolvedValue(makeSampleInsights());

      await invokeJobs(['--once']).catch(() => {});

      expect(mockGetJobInsights).toHaveBeenCalledWith(7);
    });

    it('writes header containing "MemoriaHub Job Queue" to stdout', async () => {
      mockGetJobInsights.mockResolvedValue(makeSampleInsights());

      await invokeJobs(['--once']).catch(() => {});

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toMatch(/MemoriaHub Job Queue/i);
    });

    it('writes pending count to stdout', async () => {
      mockGetJobInsights.mockResolvedValue(makeSampleInsights({ live: {
        total: 10,
        byStatus: { pending: 3, running: 1, succeeded: 5, failed: 1 },
        pending: 3,
        running: 1,
        failed: 1,
        scheduled: 0,
        rateLimited: 0,
        retried: 2,
        byType: [
          { type: 'face_detection', pending: 3, running: 1, succeeded: 5, failed: 1, total: 10 },
        ],
      } as any }));

      await invokeJobs(['--once']).catch(() => {});

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('Pending');
      expect(output).toContain('3');
    });

    it('writes face_detection type to the table', async () => {
      mockGetJobInsights.mockResolvedValue(makeSampleInsights());

      await invokeJobs(['--once']).catch(() => {});

      const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(output).toContain('face_detection');
    });

    it('exits with 0 after printing the snapshot', async () => {
      mockGetJobInsights.mockResolvedValue(makeSampleInsights());

      await expect(invokeJobs(['--once'])).rejects.toThrow('process.exit(0)');
    });

    it('shows permission error and exits 1 on 403 ApiError', async () => {
      const { ApiError } = await import('../../src/api.js');
      mockGetJobInsights.mockRejectedValue(new ApiError(403, 'Forbidden'));

      await expect(invokeJobs(['--once'])).rejects.toThrow('process.exit(1)');
      expect(mockUiError).toHaveBeenCalledWith(
        expect.stringContaining('admin access token'),
      );
    });

    it('shows generic error and exits 1 on fetch failure', async () => {
      mockGetJobInsights.mockRejectedValue(new Error('Connection refused'));

      await expect(invokeJobs(['--once'])).rejects.toThrow('process.exit(1)');
      expect(mockUiError).toHaveBeenCalledWith(
        expect.stringContaining('Connection refused'),
      );
    });
  });

  // =========================================================================
  // --window flag
  // =========================================================================

  describe('--window flag', () => {
    it('passes parsed windowDays to getJobInsights when --window 14', async () => {
      mockGetJobInsights.mockResolvedValue(makeSampleInsights({ windowDays: 14 }));

      await invokeJobs(['--json', '--window', '14']).catch(() => {});

      expect(mockGetJobInsights).toHaveBeenCalledWith(14);
    });

    it('passes windowDays=30 to getJobInsights when --window 30', async () => {
      mockGetJobInsights.mockResolvedValue(makeSampleInsights({ windowDays: 30 }));

      await invokeJobs(['--once', '--window', '30']).catch(() => {});

      expect(mockGetJobInsights).toHaveBeenCalledWith(30);
    });
  });

  // =========================================================================
  // Config usage
  // =========================================================================

  describe('config usage', () => {
    it('calls requireConfig to retrieve server credentials', async () => {
      mockGetJobInsights.mockResolvedValue(makeSampleInsights());

      await invokeJobs(['--once']).catch(() => {});

      expect(mockRequireConfig).toHaveBeenCalled();
    });
  });
});

// Suppress unused import warning
void jest;
