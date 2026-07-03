/**
 * test/update-notice.spec.ts
 *
 * Unit tests for printHeadlessUpdateNotice(currentVersion), the headless
 * "new version available" stderr notice.
 *
 * Uses the shared getDb() singleton, swapped out for an in-memory database
 * via _setDbForTesting() so no real on-disk DB is touched. The singleton is
 * reset to closed (closeDb()) after every test so it never leaks a
 * ':memory:' instance into other test files/suites that expect the real
 * on-disk DB from getDb().
 *
 * No real network calls are made: global.fetch is replaced with a jest.fn()
 * before each test and restored afterwards, matching the pattern used in
 * version-check.spec.ts.
 */

import { jest } from '@jest/globals';
import { getDb, openDb, _setDbForTesting, closeDb } from '../src/db/database.js';
import { SettingsRepo } from '../src/repo/settings.js';
import { printHeadlessUpdateNotice } from '../src/update-notice.js';

describe('printHeadlessUpdateNotice', () => {
  const savedFetch: typeof global.fetch = global.fetch;
  let mockFetch: jest.Mock;
  let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch as unknown as typeof global.fetch;
    _setDbForTesting(openDb(':memory:'));
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    global.fetch = savedFetch;
    stderrSpy.mockRestore();
    closeDb();
    jest.clearAllMocks();
  });

  it('writes an "Update available" line to stderr when a newer version is cached', async () => {
    new SettingsRepo(getDb()).setUpdateCheckCache('9.9.9');

    await printHeadlessUpdateNotice('1.1.4');

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const [written] = stderrSpy.mock.calls[0] as [string];
    expect(written).toContain('Update available');
    expect(written).toContain('9.9.9');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not write to stderr when the cached version is not newer than current', async () => {
    new SettingsRepo(getDb()).setUpdateCheckCache('1.1.4');

    await printHeadlessUpdateNotice('1.1.4');

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('does not write to stderr when there is no cache and the network check fails', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    await printHeadlessUpdateNotice('1.1.4');

    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
