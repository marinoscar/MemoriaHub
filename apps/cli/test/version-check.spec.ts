/**
 * test/version-check.spec.ts
 *
 * Unit tests for:
 *   - compareSemver(a, b)  — pure synchronous comparator
 *   - checkForUpdate(currentVersion)  — async fetch with silent error handling
 *
 * No real network calls are made: global.fetch is replaced with a jest.fn()
 * before each test and restored afterwards.
 */

import { jest } from '@jest/globals';
import { compareSemver, checkForUpdate } from '../src/version-check.js';

// ---------------------------------------------------------------------------
// compareSemver — table-driven tests
// ---------------------------------------------------------------------------

describe('compareSemver', () => {
  describe('equal versions', () => {
    it('returns 0 for identical versions', () => {
      expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    });

    it('returns 0 when both are "0.0.0"', () => {
      expect(compareSemver('0.0.0', '0.0.0')).toBe(0);
    });
  });

  describe('a > b (returns 1)', () => {
    it('returns 1 when minor is higher: 1.1.0 vs 1.0.0', () => {
      expect(compareSemver('1.1.0', '1.0.0')).toBe(1);
    });

    it('returns 1 when patch is higher: 2.0.1 vs 2.0.0', () => {
      expect(compareSemver('2.0.1', '2.0.0')).toBe(1);
    });

    it('returns 1 when major is higher: 2.0.0 vs 1.9.9', () => {
      expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
    });
  });

  describe('a < b (returns -1)', () => {
    it('returns -1 when patch is lower: 1.0.0 vs 1.0.1', () => {
      expect(compareSemver('1.0.0', '1.0.1')).toBe(-1);
    });

    it('returns -1 when minor is lower: 1.0.5 vs 1.1.0', () => {
      expect(compareSemver('1.0.5', '1.1.0')).toBe(-1);
    });

    it('returns -1 when major is lower: 0.9.9 vs 1.0.0', () => {
      expect(compareSemver('0.9.9', '1.0.0')).toBe(-1);
    });
  });

  describe('leading "v" stripped', () => {
    it('treats "v1.2.3" equal to "1.2.3"', () => {
      expect(compareSemver('v1.2.3', '1.2.3')).toBe(0);
    });

    it('treats "v1.2.3" equal to "v1.2.3"', () => {
      expect(compareSemver('v1.2.3', 'v1.2.3')).toBe(0);
    });

    it('compares correctly when only one side has a "v" prefix', () => {
      expect(compareSemver('v2.0.0', '1.0.0')).toBe(1);
    });
  });

  describe('pre-release suffix ignored', () => {
    it('treats "1.0.0-beta" equal to "1.0.0"', () => {
      expect(compareSemver('1.0.0-beta', '1.0.0')).toBe(0);
    });

    it('treats "1.0.0-alpha.1" equal to "1.0.0-rc.2"', () => {
      expect(compareSemver('1.0.0-alpha.1', '1.0.0-rc.2')).toBe(0);
    });

    it('pre-release does not override a higher base version', () => {
      expect(compareSemver('1.1.0-beta', '1.0.0')).toBe(1);
    });
  });

  describe('missing version parts treated as 0', () => {
    it('"1.0" equals "1.0.0"', () => {
      expect(compareSemver('1.0', '1.0.0')).toBe(0);
    });

    it('"1" equals "1.0.0"', () => {
      expect(compareSemver('1', '1.0.0')).toBe(0);
    });

    it('"2" is greater than "1.9.9"', () => {
      expect(compareSemver('2', '1.9.9')).toBe(1);
    });
  });

  describe('major dominates minor and patch', () => {
    it('major win: 2.0.0 > 1.999.999', () => {
      expect(compareSemver('2.0.0', '1.999.999')).toBe(1);
    });

    it('major win: 1.0.0 < 2.0.0 regardless of minor/patch', () => {
      expect(compareSemver('1.999.999', '2.0.0')).toBe(-1);
    });
  });
});

// ---------------------------------------------------------------------------
// checkForUpdate — mock global fetch
// ---------------------------------------------------------------------------

describe('checkForUpdate', () => {
  // Save and restore the real fetch
  const savedFetch: typeof global.fetch = global.fetch;
  let mockFetch: jest.Mock;

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = savedFetch;
    jest.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Update available
  // -----------------------------------------------------------------------

  it('returns updateAvailable=true when remote version is newer', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '9.9.9' }),
    });

    const result = await checkForUpdate('1.0.0');

    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe('9.9.9');
  });

  it('passes the signal to fetch', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '9.9.9' }),
    });

    await checkForUpdate('1.0.0');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockFetch.mock.calls[0] as [string, { signal: AbortSignal }];
    expect(init.signal).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // No update (equal or lower remote)
  // -----------------------------------------------------------------------

  it('returns updateAvailable=false when remote version equals current', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '1.0.0' }),
    });

    const result = await checkForUpdate('1.0.0');

    expect(result.updateAvailable).toBe(false);
    expect(result.latestVersion).toBe('1.0.0');
  });

  it('returns updateAvailable=false when remote version is lower than current', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '0.9.0' }),
    });

    const result = await checkForUpdate('1.0.0');

    expect(result.updateAvailable).toBe(false);
    expect(result.latestVersion).toBe('0.9.0');
  });

  // -----------------------------------------------------------------------
  // Silent failure on errors — all must resolve, never throw
  // -----------------------------------------------------------------------

  it('resolves with updateAvailable=false when fetch rejects (network error)', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    await expect(checkForUpdate('1.0.0')).resolves.toEqual({
      updateAvailable: false,
      latestVersion: null,
    });
  });

  it('resolves with updateAvailable=false when response is not ok', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ version: '9.9.9' }),
    });

    await expect(checkForUpdate('1.0.0')).resolves.toEqual({
      updateAvailable: false,
      latestVersion: null,
    });
  });

  it('resolves with updateAvailable=false when .json() throws', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('Parse error');
      },
    });

    await expect(checkForUpdate('1.0.0')).resolves.toEqual({
      updateAvailable: false,
      latestVersion: null,
    });
  });

  it('resolves with updateAvailable=false when JSON has no version field', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ name: 'some-package' }),
    });

    await expect(checkForUpdate('1.0.0')).resolves.toEqual({
      updateAvailable: false,
      latestVersion: null,
    });
  });

  it('resolves with updateAvailable=false when version field is empty string', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: '' }),
    });

    await expect(checkForUpdate('1.0.0')).resolves.toEqual({
      updateAvailable: false,
      latestVersion: null,
    });
  });

  it('resolves with updateAvailable=false when version field is a non-string type', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ version: 42 }),
    });

    await expect(checkForUpdate('1.0.0')).resolves.toEqual({
      updateAvailable: false,
      latestVersion: null,
    });
  });
});
