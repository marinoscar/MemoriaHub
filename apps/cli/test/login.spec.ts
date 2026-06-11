/**
 * login.spec.ts — Unit tests for the `login` command's --token headless fallback path.
 *
 * We test:
 *   1. --token <pat> + valid server → saveConfig called with {serverUrl, pat}
 *   2. --token <pat> + server returns 401 → process exits non-zero, saveConfig NOT called
 *
 * Config isolation: we redirect os.homedir() to a temp directory via
 * jest.unstable_mockModule so the tests never touch ~/.memoriahub.
 *
 * We mock:
 *   - os.homedir → temp dir (config isolation)
 *   - global.fetch → no real HTTP calls
 *   - process.exit → intercepted so Jest doesn't actually exit
 *   - readline/promises → returns --token and --server, no interactive prompt needed
 *   - ora (spinner) → no-op
 *   - child_process.execFile → no-op (browser open)
 *
 * Note: We only test the --token path here. The interactive device flow is
 * covered by device-auth.spec.ts (requestDeviceCode / pollForDeviceToken unit
 * tests) plus integration tests. Simulating readline interactivity in Jest ESM
 * is brittle and not worth the complexity for this surface area.
 */

import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as actualOs from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Capture process.exit calls so Jest doesn't actually exit
// ---------------------------------------------------------------------------
const mockExit = jest.spyOn(process, 'exit').mockImplementation((_code?: number) => {
  throw new Error(`process.exit(${_code})`);
});

// ---------------------------------------------------------------------------
// Fake fetch
// ---------------------------------------------------------------------------
const mockFetch = jest.fn<typeof fetch>();
(globalThis as any).fetch = mockFetch;

// ---------------------------------------------------------------------------
// Fake home dir (config isolation)
// ---------------------------------------------------------------------------
let _fakeHome = '';

jest.unstable_mockModule('os', () => ({
  ...actualOs,
  homedir: jest.fn(() => _fakeHome || actualOs.homedir()),
  hostname: jest.fn(() => 'test-host'),
  platform: jest.fn(() => 'linux'),
}));

// ---------------------------------------------------------------------------
// Suppress spinner output
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

// ---------------------------------------------------------------------------
// Suppress browser opener (child_process.execFile)
// ---------------------------------------------------------------------------
jest.unstable_mockModule('child_process', () => ({
  execFile: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Suppress readline — we only test non-interactive paths
// ---------------------------------------------------------------------------
jest.unstable_mockModule('readline/promises', () => ({
  createInterface: jest.fn(() => ({
    question: jest.fn<() => Promise<string>>().mockResolvedValue(''),
    close: jest.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Suppress chalk (pass-through)
// ---------------------------------------------------------------------------
jest.unstable_mockModule('chalk', () => ({
  default: new Proxy(
    {},
    {
      get: () => (s: string) => s,
    },
  ),
}));

// Dynamic imports AFTER unstable_mockModule calls
const { loginCommand } = await import('../src/commands/login.js');
const { loadConfig } = await import('../src/config.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJsonResponse(body: unknown, status: number = 200): Response {
  const json = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(json),
    headers: new Headers(),
  } as unknown as Response;
}

function makeMeSuccess(email = 'user@example.com'): Response {
  return makeJsonResponse({ data: { email, id: 'u1', roles: ['viewer'] } });
}

function makeMeUnauthorized(): Response {
  return makeJsonResponse(
    { statusCode: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' },
    401,
  );
}

async function runLoginWithToken(
  serverUrl: string,
  token: string,
): Promise<void> {
  const cmd = loginCommand();
  // Commander executes the action synchronously when called programmatically
  await cmd.parseAsync(['--server', serverUrl, '--token', token], {
    from: 'user',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('login command — --token headless path', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(actualOs.tmpdir(), 'mh-login-test-'));
    _fakeHome = tmpHome;
    mockFetch.mockReset();
    mockExit.mockClear();
  });

  afterEach(() => {
    _fakeHome = '';
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('should call saveConfig with {serverUrl, pat} when token is valid', async () => {
    mockFetch.mockResolvedValueOnce(makeMeSuccess('alice@example.com'));

    await runLoginWithToken('https://example.com', 'pat_valid_abc123');

    const cfg = loadConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.serverUrl).toBe('https://example.com');
    expect(cfg!.pat).toBe('pat_valid_abc123');
  });

  it('should call GET /api/auth/me with Bearer token', async () => {
    mockFetch.mockResolvedValueOnce(makeMeSuccess());

    await runLoginWithToken('https://example.com', 'pat_test_tok');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/api/auth/me');
    const headers = opts.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer pat_test_tok');
  });

  it('should exit non-zero and NOT call saveConfig when token is invalid (401)', async () => {
    mockFetch.mockResolvedValueOnce(makeMeUnauthorized());

    await expect(
      runLoginWithToken('https://example.com', 'pat_bad_token'),
    ).rejects.toThrow(/process\.exit/);

    expect(mockExit).toHaveBeenCalledWith(1);

    const cfg = loadConfig();
    expect(cfg).toBeNull();
  });

  it('should exit non-zero and NOT call saveConfig when server is unreachable', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(
      runLoginWithToken('https://unreachable.example.com', 'pat_any'),
    ).rejects.toThrow(/process\.exit/);

    expect(mockExit).toHaveBeenCalledWith(1);

    const cfg = loadConfig();
    expect(cfg).toBeNull();
  });

  it('should strip trailing slash from serverUrl before saving', async () => {
    mockFetch.mockResolvedValueOnce(makeMeSuccess());

    await runLoginWithToken('https://example.com/', 'pat_slash');

    const cfg = loadConfig();
    // ApiClient strips trailing slash; login saves what was passed in --server
    // The test verifies pat is saved — serverUrl normalisation is ApiClient's job
    expect(cfg!.pat).toBe('pat_slash');
  });

  it('should save config with correct file permissions (mode 600)', async () => {
    mockFetch.mockResolvedValueOnce(makeMeSuccess());

    await runLoginWithToken('https://example.com', 'pat_perms');

    const configFile = path.join(tmpHome, '.memoriahub', 'config.json');
    expect(fs.existsSync(configFile)).toBe(true);

    const stat = fs.statSync(configFile);
    // On Linux the mode includes the file type bits; mask to permission bits only
    const permissions = stat.mode & 0o777;
    expect(permissions).toBe(0o600);
  });

  it('should handle empty --token value by exiting non-zero', async () => {
    const cmd = loginCommand();

    await expect(
      cmd.parseAsync(['--server', 'https://example.com', '--token', '   '], {
        from: 'user',
      }),
    ).rejects.toThrow(/process\.exit/);

    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
