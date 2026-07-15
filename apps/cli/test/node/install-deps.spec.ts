/**
 * test/node/install-deps.spec.ts
 *
 * Unit tests for node/install-deps.ts's individually-testable step
 * functions backing `memoriahub node install-deps`.
 *
 * Strategy (mirrors test/convert/ffmpeg.spec.ts and test/node/self-test.ts's
 * established patterns for this repo):
 *   - `node:child_process`'s `spawn` is mocked with an EventEmitter-based
 *     fake so every process invocation in this module is fully controlled —
 *     no real `apt-get`/`docker`/`sudo`/`npm` is ever executed.
 *   - `node:fs`'s `readFileSync` is mocked for `detectLinuxDistro()`'s
 *     `/etc/os-release` parsing.
 *   - `node:os`'s `userInfo` is mocked for `ensureDocker()`'s `usermod` call.
 *   - `./capabilities.js`, `./self-test.js`, `./models.js`, `../config.js`,
 *     `../api.js`, and `@memoriahub/enrichment-compute/ocr` are all mocked
 *     via jest.unstable_mockModule so no native library, network call, or
 *     real config file is ever touched.
 */

import { jest } from '@jest/globals';
import { EventEmitter } from 'events';
import * as fsActual from 'fs';
import * as osActual from 'os';

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE importing the module under test.
// ---------------------------------------------------------------------------

interface SpawnResultConfig {
  code: number;
  stdout?: string;
  stderr?: string;
  /** Emit an 'error' event (e.g. ENOENT) instead of a normal close. */
  spawnError?: string;
}

type SpawnRouter = (cmd: string, args: string[]) => SpawnResultConfig;

let spawnRouter: SpawnRouter = () => ({ code: 0 });
const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

class FakeChildProcess {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  private handlers: Record<string, Array<(...a: unknown[]) => void>> = {};

  on(event: string, cb: (...a: unknown[]) => void): this {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers[event] ?? []) cb(...args);
  }
}

const spawnMock = jest.fn((cmd: string, args: string[]) => {
  spawnCalls.push({ cmd, args });
  const child = new FakeChildProcess();
  const cfg = spawnRouter(cmd, args);

  setImmediate(() => {
    if (cfg.spawnError) {
      child.emit('error', Object.assign(new Error('spawn failed'), { code: cfg.spawnError }));
      return;
    }
    if (cfg.stdout) child.stdout.emit('data', Buffer.from(cfg.stdout));
    if (cfg.stderr) child.stderr.emit('data', Buffer.from(cfg.stderr));
    child.emit('close', cfg.code);
  });

  return child as unknown as import('node:child_process').ChildProcess;
});

jest.unstable_mockModule('node:child_process', () => ({
  spawn: spawnMock,
}));

let osReleaseContent: string | null = null;
const readFileSyncMock = jest.fn((p: string) => {
  if (p === '/etc/os-release') {
    if (osReleaseContent === null) {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    }
    return osReleaseContent;
  }
  return fsActual.readFileSync(p as never, 'utf8');
});

jest.unstable_mockModule('node:fs', () => ({
  ...fsActual,
  readFileSync: readFileSyncMock,
}));

const userInfoMock = jest.fn(() => ({ username: 'testuser' }));
// Controllable core-count for defaultComprefaceProcesses()'s cores-2 clamp
// math. `install-deps.ts` prefers `os.availableParallelism()`; defaulting
// this to the real core count keeps every other test in this file (which
// doesn't care about core count) unaffected, while individual
// `defaultComprefaceProcesses`/`buildComprefaceRunArgs` tests override it.
let availableParallelismResult = osActual.cpus().length;
const availableParallelismMock = jest.fn(() => availableParallelismResult);
jest.unstable_mockModule('node:os', () => ({
  ...osActual,
  userInfo: userInfoMock,
  availableParallelism: availableParallelismMock,
}));

const mockDetectCapabilities = jest.fn();
jest.unstable_mockModule('../../src/node/capabilities.js', () => ({
  NATIVE_MODULES: {
    onnxruntime: 'onnxruntime-node',
    sharp: 'sharp',
    tfjs: '@tensorflow/tfjs',
    tfjsWasm: '@tensorflow/tfjs-backend-wasm',
    human: '@vladmandic/human',
    tesseract: 'tesseract.js',
  },
  detectCapabilities: mockDetectCapabilities,
}));

const mockTestCompreface = jest.fn();
jest.unstable_mockModule('../../src/node/self-test.js', () => ({
  tesseractLangDir: () => '/tmp/mh-test-tesseract',
  testCompreface: mockTestCompreface,
}));

const mockEnsureModels = jest.fn();
jest.unstable_mockModule('../../src/node/models.js', () => ({
  ensureModels: mockEnsureModels,
}));

const mockLoadConfig = jest.fn();
jest.unstable_mockModule('../../src/config.js', () => ({
  loadConfig: mockLoadConfig,
}));

const mockGetModelManifest = jest.fn();
const mockApiClientCtor = jest.fn();
jest.unstable_mockModule('../../src/api.js', () => ({
  ApiClient: class {
    constructor(opts: unknown) {
      mockApiClientCtor(opts);
    }
    getModelManifest = mockGetModelManifest;
  },
}));

const mockCreateOcrEngine = jest.fn();
jest.unstable_mockModule('@memoriahub/enrichment-compute/ocr', () => ({
  createOcrEngine: mockCreateOcrEngine,
}));

const {
  detectLinuxDistro,
  isRoot,
  runWithSudoAnnounced,
  ensureAptPackages,
  ensureFfmpeg,
  ensureNpmNativeDeps,
  ensureTesseractLanguageData,
  ensureDocker,
  ensureComprefaceContainer,
  verifyCompreface,
  ensureModelsIfConfigured,
  defaultComprefaceProcesses,
  buildComprefaceRunArgs,
} = await import('../../src/node/install-deps.js');

type CapabilityStatus = { available: boolean; detail?: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_CAPS_PRESENT: Record<string, CapabilityStatus> = {
  onnxruntime: { available: true },
  sharp: { available: true },
  tfjs: { available: true },
  tfjsWasm: { available: true },
  human: { available: true },
  tesseract: { available: true },
  ffmpeg: { available: true },
  ffprobe: { available: true },
};

let originalGetuid: typeof process.getuid;

beforeEach(() => {
  spawnCalls.length = 0;
  spawnMock.mockClear();
  spawnRouter = () => ({ code: 0 });
  osReleaseContent = null;
  mockDetectCapabilities.mockReset();
  mockTestCompreface.mockReset();
  mockEnsureModels.mockReset();
  mockLoadConfig.mockReset();
  mockGetModelManifest.mockReset();
  mockApiClientCtor.mockReset();
  mockCreateOcrEngine.mockReset();
  userInfoMock.mockClear();
  availableParallelismResult = osActual.cpus().length;
  availableParallelismMock.mockClear();
  originalGetuid = process.getuid;
  // Default: not root.
  (process as unknown as { getuid: () => number }).getuid = () => 1000;
});

afterEach(() => {
  if (originalGetuid) {
    (process as unknown as { getuid: () => number }).getuid = originalGetuid;
  }
});

const UBUNTU_OS_RELEASE = [
  'NAME="Ubuntu"',
  'VERSION="22.04.3 LTS (Jammy Jellyfish)"',
  'ID=ubuntu',
  'ID_LIKE=debian',
  'PRETTY_NAME="Ubuntu 22.04.3 LTS"',
  '',
].join('\n');

const DEBIAN_OS_RELEASE = ['NAME="Debian GNU/Linux"', 'ID=debian', 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"', ''].join(
  '\n',
);

const FEDORA_OS_RELEASE = [
  'NAME="Fedora Linux"',
  'ID=fedora',
  'ID_LIKE="rhel fedora"',
  'PRETTY_NAME="Fedora Linux 39"',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// detectLinuxDistro
// ---------------------------------------------------------------------------

describe('detectLinuxDistro', () => {
  it('classifies Ubuntu as debian family', () => {
    osReleaseContent = UBUNTU_OS_RELEASE;
    const result = detectLinuxDistro();
    expect(result.family).toBe('debian');
    expect(result.prettyName).toBe('Ubuntu 22.04.3 LTS');
  });

  it('classifies Debian as debian family', () => {
    osReleaseContent = DEBIAN_OS_RELEASE;
    const result = detectLinuxDistro();
    expect(result.family).toBe('debian');
    expect(result.prettyName).toMatch(/Debian/);
  });

  it('classifies Fedora as other', () => {
    osReleaseContent = FEDORA_OS_RELEASE;
    const result = detectLinuxDistro();
    expect(result.family).toBe('other');
    expect(result.prettyName).toMatch(/Fedora/);
  });

  it('gracefully handles a missing /etc/os-release as other', () => {
    osReleaseContent = null;
    const result = detectLinuxDistro();
    expect(result.family).toBe('other');
    expect(result.prettyName).toMatch(/Unknown/);
  });
});

// ---------------------------------------------------------------------------
// isRoot
// ---------------------------------------------------------------------------

describe('isRoot', () => {
  it('is false for a non-root uid', () => {
    (process as unknown as { getuid: () => number }).getuid = () => 1000;
    expect(isRoot()).toBe(false);
  });

  it('is true for uid 0', () => {
    (process as unknown as { getuid: () => number }).getuid = () => 0;
    expect(isRoot()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runWithSudoAnnounced
// ---------------------------------------------------------------------------

describe('runWithSudoAnnounced', () => {
  it('runs the command directly (no sudo prefix) when already root', async () => {
    (process as unknown as { getuid: () => number }).getuid = () => 0;
    spawnRouter = () => ({ code: 0, stdout: 'ok' });

    const res = await runWithSudoAnnounced('apt-get', ['update']);

    expect(res.ok).toBe(true);
    expect(spawnCalls).toEqual([{ cmd: 'apt-get', args: ['update'] }]);
  });

  it('prefixes with sudo when not root and sudo is available', async () => {
    spawnRouter = (cmd) => {
      if (cmd === 'which') return { code: 0, stdout: '/usr/bin/sudo\n' };
      return { code: 0 };
    };

    const res = await runWithSudoAnnounced('apt-get', ['install', '-y', 'ffmpeg']);

    expect(res.ok).toBe(true);
    expect(spawnCalls).toContainEqual({ cmd: 'sudo', args: ['apt-get', 'install', '-y', 'ffmpeg'] });
  });

  it('fails clearly when not root and sudo is unavailable', async () => {
    spawnRouter = (cmd) => (cmd === 'which' ? { code: 1 } : { code: 0 });

    const res = await runWithSudoAnnounced('apt-get', ['update']);

    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/sudo is not available/);
    // The real apt-get command must never have been attempted.
    expect(spawnCalls.some((c) => c.cmd === 'apt-get' || c.cmd === 'sudo')).toBe(false);
  });

  it('announces the exact command before executing it', async () => {
    const warnSpy = jest.spyOn((await import('../../src/ui.js')).ui, 'warn').mockImplementation(() => {});
    spawnRouter = (cmd) => (cmd === 'which' ? { code: 0, stdout: '/usr/bin/sudo\n' } : { code: 0 });

    await runWithSudoAnnounced('apt-get', ['install', '-y', 'ffmpeg']);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('sudo apt-get install -y ffmpeg'),
    );
    warnSpy.mockRestore();
  });

  it('dry-run never spawns any process and returns a synthetic ok result', async () => {
    const res = await runWithSudoAnnounced('apt-get', ['install', '-y', 'ffmpeg'], { dryRun: true });

    expect(res.ok).toBe(true);
    expect(res.stdout).toMatch(/dry run/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ensureAptPackages
// ---------------------------------------------------------------------------

describe('ensureAptPackages', () => {
  it('is unsupported on a non-debian distro', async () => {
    osReleaseContent = FEDORA_OS_RELEASE;
    const res = await ensureAptPackages(['ffmpeg']);
    expect(res.status).toBe('unsupported');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('runs apt-get update then install -y on a debian distro', async () => {
    osReleaseContent = UBUNTU_OS_RELEASE;
    (process as unknown as { getuid: () => number }).getuid = () => 0;
    spawnRouter = () => ({ code: 0 });

    const res = await ensureAptPackages(['ffmpeg']);

    expect(res.status).toBe('installed');
    expect(spawnCalls).toEqual([
      { cmd: 'apt-get', args: ['update'] },
      { cmd: 'apt-get', args: ['install', '-y', 'ffmpeg'] },
    ]);
  });

  it('fails when apt-get install exits non-zero', async () => {
    osReleaseContent = UBUNTU_OS_RELEASE;
    (process as unknown as { getuid: () => number }).getuid = () => 0;
    spawnRouter = (_cmd, args) =>
      args[0] === 'install' ? { code: 1, stderr: 'E: Unable to locate package' } : { code: 0 };

    const res = await ensureAptPackages(['ffmpeg']);

    expect(res.status).toBe('failed');
    expect(res.detail).toMatch(/Unable to locate package/);
  });
});

// ---------------------------------------------------------------------------
// ensureFfmpeg
// ---------------------------------------------------------------------------

describe('ensureFfmpeg', () => {
  it('skips when both ffmpeg and ffprobe are already available', async () => {
    const res = await ensureFfmpeg({ ffmpeg: { available: true }, ffprobe: { available: true } });
    expect(res.status).toBe('skipped');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('is unsupported on a non-debian distro when missing', async () => {
    osReleaseContent = FEDORA_OS_RELEASE;
    const res = await ensureFfmpeg({ ffmpeg: { available: false }, ffprobe: { available: false } });
    expect(res.status).toBe('unsupported');
  });

  it('installs via apt and verifies success', async () => {
    osReleaseContent = UBUNTU_OS_RELEASE;
    (process as unknown as { getuid: () => number }).getuid = () => 0;
    spawnRouter = () => ({ code: 0 });
    mockDetectCapabilities.mockResolvedValue({
      ffmpeg: { available: true },
      ffprobe: { available: true },
    });

    const res = await ensureFfmpeg({ ffmpeg: { available: false }, ffprobe: { available: false } });

    expect(res.status).toBe('installed');
  });

  it('fails when apt succeeds but ffmpeg/ffprobe are still missing afterward', async () => {
    osReleaseContent = UBUNTU_OS_RELEASE;
    (process as unknown as { getuid: () => number }).getuid = () => 0;
    spawnRouter = () => ({ code: 0 });
    mockDetectCapabilities.mockResolvedValue({
      ffmpeg: { available: false },
      ffprobe: { available: false },
    });

    const res = await ensureFfmpeg({ ffmpeg: { available: false }, ffprobe: { available: false } });

    expect(res.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// ensureNpmNativeDeps
// ---------------------------------------------------------------------------

describe('ensureNpmNativeDeps', () => {
  it('skips when every native module is already present', async () => {
    const res = await ensureNpmNativeDeps('/repo/apps/cli', ALL_CAPS_PRESENT);
    expect(res.status).toBe('skipped');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('dry-run reports what would happen without spawning npm', async () => {
    const res = await ensureNpmNativeDeps(
      '/repo/apps/cli',
      { ...ALL_CAPS_PRESENT, sharp: { available: false } },
      { dryRun: true },
    );
    expect(res.status).toBe('skipped');
    expect(res.detail).toMatch(/Dry run/);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('installs successfully after a single npm install', async () => {
    spawnRouter = () => ({ code: 0 });
    mockDetectCapabilities.mockResolvedValue(ALL_CAPS_PRESENT);

    const res = await ensureNpmNativeDeps('/repo/apps/cli', {
      ...ALL_CAPS_PRESENT,
      sharp: { available: false },
    });

    expect(res.status).toBe('installed');
    expect(spawnCalls[0]).toEqual({ cmd: 'npm', args: ['install'] });
  });

  it('falls back to a build-from-source retry when still missing, and succeeds', async () => {
    osReleaseContent = UBUNTU_OS_RELEASE;
    (process as unknown as { getuid: () => number }).getuid = () => 0;

    let npmInstallCount = 0;
    spawnRouter = (cmd, args) => {
      if (cmd === 'which') return { code: 0 }; // gcc/python3/sudo all present
      if (cmd === 'npm' && args[0] === 'install') {
        npmInstallCount += 1;
        return { code: 0 };
      }
      return { code: 0 };
    };

    // First detectCapabilities() re-check (after plain npm install): still missing.
    // Second re-check (after source-build retry): now present.
    mockDetectCapabilities
      .mockResolvedValueOnce({ ...ALL_CAPS_PRESENT, sharp: { available: false } })
      .mockResolvedValueOnce(ALL_CAPS_PRESENT);

    const res = await ensureNpmNativeDeps('/repo/apps/cli', {
      ...ALL_CAPS_PRESENT,
      sharp: { available: false },
    });

    expect(res.status).toBe('installed');
    expect(res.detail).toMatch(/source-build fallback/);
    expect(npmInstallCount).toBe(2);
  });

  it('reports failed when every remediation attempt is exhausted', async () => {
    osReleaseContent = UBUNTU_OS_RELEASE;
    (process as unknown as { getuid: () => number }).getuid = () => 0;
    spawnRouter = (cmd, args) => {
      if (cmd === 'npm' && args[0] === 'install') return { code: 1, stderr: 'gyp ERR! build error' };
      return { code: 0 };
    };
    mockDetectCapabilities.mockResolvedValue({ ...ALL_CAPS_PRESENT, sharp: { available: false } });

    const res = await ensureNpmNativeDeps('/repo/apps/cli', {
      ...ALL_CAPS_PRESENT,
      sharp: { available: false },
    });

    expect(res.status).toBe('failed');
    expect(res.detail).toMatch(/sharp/);
  });
});

// ---------------------------------------------------------------------------
// ensureTesseractLanguageData
// ---------------------------------------------------------------------------

describe('ensureTesseractLanguageData', () => {
  it('skips when the tesseract capability is already operational', async () => {
    const res = await ensureTesseractLanguageData({ tesseract: { available: true, detail: 'ok' } });
    expect(res.status).toBe('skipped');
    expect(mockCreateOcrEngine).not.toHaveBeenCalled();
  });

  it('downloads language data by creating and tearing down an OCR engine', async () => {
    const terminate = jest.fn().mockResolvedValue(undefined);
    mockCreateOcrEngine.mockResolvedValue({ languages: ['eng'], recognizeFrame: jest.fn(), terminate });

    const res = await ensureTesseractLanguageData({ tesseract: { available: false } });

    expect(res.status).toBe('installed');
    expect(mockCreateOcrEngine).toHaveBeenCalledWith({
      langDir: '/tmp/mh-test-tesseract',
      languages: ['eng'],
    });
    expect(terminate).toHaveBeenCalled();
  });

  it('reports failed when engine creation rejects (e.g. network error)', async () => {
    mockCreateOcrEngine.mockRejectedValue(new Error('ENOTFOUND cdn'));

    const res = await ensureTesseractLanguageData({ tesseract: { available: false } });

    expect(res.status).toBe('failed');
    expect(res.detail).toMatch(/ENOTFOUND cdn/);
  });
});

// ---------------------------------------------------------------------------
// ensureDocker
// ---------------------------------------------------------------------------

describe('ensureDocker', () => {
  it('skips when docker --version and docker info both already succeed', async () => {
    (process as unknown as { getuid: () => number }).getuid = () => 0;
    spawnRouter = () => ({ code: 0 });

    const res = await ensureDocker();

    expect(res.status).toBe('skipped');
  });

  it('is unsupported on a non-debian distro when docker is missing', async () => {
    (process as unknown as { getuid: () => number }).getuid = () => 0;
    osReleaseContent = FEDORA_OS_RELEASE;
    spawnRouter = (cmd, args) =>
      cmd === 'docker' && args[0] === '--version' ? { code: 127 } : { code: 0 };

    const res = await ensureDocker();

    expect(res.status).toBe('unsupported');
  });

  it('installs docker.io, enables the service, adds the user to the group, and verifies', async () => {
    osReleaseContent = UBUNTU_OS_RELEASE;
    (process as unknown as { getuid: () => number }).getuid = () => 0;

    spawnRouter = (cmd, args) => {
      // docker CLI isn't installed yet, so the pre-install `docker --version`
      // probe fails (which short-circuits the `docker info` probe too — see
      // ensureDocker's implementation). The only `docker info` call that
      // actually happens is the post-install verification, which succeeds.
      if (cmd === 'docker' && args[0] === '--version') return { code: 127 };
      return { code: 0 };
    };

    const res = await ensureDocker();

    expect(res.status).toBe('installed');
    expect(res.requiresRelogin).toBe(true);
    expect(spawnCalls).toContainEqual({ cmd: 'usermod', args: ['-aG', 'docker', 'testuser'] });
  });

  it('reports failed when docker info still fails after install attempts', async () => {
    osReleaseContent = UBUNTU_OS_RELEASE;
    (process as unknown as { getuid: () => number }).getuid = () => 0;
    spawnRouter = (cmd, args) => {
      if (cmd === 'docker' && args[0] === '--version') return { code: 127 };
      if (cmd === 'docker' && args[0] === 'info') return { code: 1, stderr: 'Cannot connect to the Docker daemon' };
      return { code: 0 };
    };

    const res = await ensureDocker();

    expect(res.status).toBe('failed');
    expect(res.detail).toMatch(/Cannot connect to the Docker daemon/);
  });
});

// ---------------------------------------------------------------------------
// ensureComprefaceContainer
// ---------------------------------------------------------------------------

describe('ensureComprefaceContainer', () => {
  it('skips when the container is already running and recreate is not requested', async () => {
    (process as unknown as { getuid: () => number }).getuid = () => 0;
    spawnRouter = (cmd, args) =>
      cmd === 'docker' && args[0] === 'ps' && !args.includes('-a')
        ? { code: 0, stdout: 'compreface-core\n' }
        : { code: 0 };

    const res = await ensureComprefaceContainer(3000);

    expect(res.status).toBe('skipped');
    expect(res.detail).toMatch(/--compreface-recreate/);
    // The function returns immediately after the single running-check `ps`
    // call — the `ps -a` existence check, `rm`, `run`, and `start` are never
    // reached.
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.cmd).toBe('docker');
    expect(spawnCalls[0]?.args[0]).toBe('ps');
    expect(spawnCalls.some((c) => c.args[0] === 'rm')).toBe(false);
    expect(spawnCalls.some((c) => c.args[0] === 'run')).toBe(false);
    expect(spawnCalls.some((c) => c.args[0] === 'start')).toBe(false);
  });

  it('recreates a RUNNING container when opts.recreate is true (rm -f then run)', async () => {
    (process as unknown as { getuid: () => number }).getuid = () => 0;
    spawnRouter = (cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps' && !args.includes('-a')) {
        return { code: 0, stdout: 'compreface-core\n' };
      }
      if (cmd === 'docker' && args[0] === 'ps' && args.includes('-a')) {
        return { code: 0, stdout: 'compreface-core\n' };
      }
      if (cmd === 'docker' && args[0] === 'image') return { code: 0 };
      return { code: 0 };
    };

    const res = await ensureComprefaceContainer(3000, { recreate: true });

    expect(res.status).toBe('installed');
    expect(spawnCalls).toContainEqual({ cmd: 'docker', args: ['rm', '-f', 'compreface-core'] });
    expect(spawnCalls.some((c) => c.cmd === 'docker' && c.args[0] === 'run')).toBe(true);
  });

  it('recreates an existing stopped container (docker rm -f then run, never docker start)', async () => {
    (process as unknown as { getuid: () => number }).getuid = () => 0;
    spawnRouter = (cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps' && !args.includes('-a')) return { code: 0, stdout: '' };
      if (cmd === 'docker' && args[0] === 'ps' && args.includes('-a')) {
        return { code: 0, stdout: 'compreface-core\n' };
      }
      if (cmd === 'docker' && args[0] === 'image') return { code: 0 }; // already present locally
      return { code: 0 };
    };

    const res = await ensureComprefaceContainer(3000);

    expect(res.status).toBe('installed');
    // `docker start` cannot change flags — a stopped container is now removed
    // and recreated via `run`, not resumed via `start`.
    expect(spawnCalls).toContainEqual({ cmd: 'docker', args: ['rm', '-f', 'compreface-core'] });
    expect(spawnCalls.some((c) => c.cmd === 'docker' && c.args[0] === 'run')).toBe(true);
    expect(spawnCalls.some((c) => c.cmd === 'docker' && c.args[0] === 'start')).toBe(false);
    // The image was already present locally, so no pull was needed.
    expect(spawnCalls.some((c) => c.args[0] === 'pull')).toBe(false);
  });

  it('pulls and runs a brand-new container when none exists', async () => {
    (process as unknown as { getuid: () => number }).getuid = () => 0;
    spawnRouter = (cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps') return { code: 0, stdout: '' };
      if (cmd === 'docker' && args[0] === 'image') return { code: 1 }; // not present locally
      return { code: 0 };
    };

    const res = await ensureComprefaceContainer(3000);

    expect(res.status).toBe('installed');
    expect(spawnCalls.some((c) => c.cmd === 'docker' && c.args[0] === 'pull')).toBe(true);
    expect(spawnCalls.some((c) => c.cmd === 'docker' && c.args[0] === 'run')).toBe(true);
  });

  it('skips the pull when the image already exists locally', async () => {
    (process as unknown as { getuid: () => number }).getuid = () => 0;
    spawnRouter = (cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps') return { code: 0, stdout: '' };
      if (cmd === 'docker' && args[0] === 'image') return { code: 0 }; // already present
      return { code: 0 };
    };

    await ensureComprefaceContainer(3000);

    expect(spawnCalls.some((c) => c.cmd === 'docker' && c.args[0] === 'pull')).toBe(false);
  });

  it('reports failed when the run command fails', async () => {
    (process as unknown as { getuid: () => number }).getuid = () => 0;
    spawnRouter = (cmd, args) => {
      if (cmd === 'docker' && args[0] === 'ps') return { code: 0, stdout: '' };
      if (cmd === 'docker' && args[0] === 'image') return { code: 0 };
      if (cmd === 'docker' && args[0] === 'run') return { code: 1, stderr: 'port is already allocated' };
      return { code: 0 };
    };

    const res = await ensureComprefaceContainer(3000);

    expect(res.status).toBe('failed');
    expect(res.detail).toMatch(/port is already allocated/);
  });
});

// ---------------------------------------------------------------------------
// defaultComprefaceProcesses
// ---------------------------------------------------------------------------

describe('defaultComprefaceProcesses', () => {
  it('clamps a high core count down to the max of 6', () => {
    availableParallelismResult = 8;
    expect(defaultComprefaceProcesses()).toBe(6);
  });

  it('clamps a low core count up to the min of 1', () => {
    availableParallelismResult = 2;
    expect(defaultComprefaceProcesses()).toBe(1);
  });

  it('returns cores - 2 for a mid-range core count', () => {
    availableParallelismResult = 4;
    expect(defaultComprefaceProcesses()).toBe(2);
  });

  // The module prefers `os.availableParallelism()` and falls back to
  // `os.cpus().length` only when `availableParallelism` isn't a function.
  // This file's `node:os` mock always exports `availableParallelism` as a
  // jest.fn (so `typeof os.availableParallelism === 'function'` is always
  // true here) — cleanly forcing the fallback branch would require the mock
  // to conditionally omit the export per-test, which isn't worth the
  // complexity for one extra branch. Instead we assert the sanity bound that
  // must hold regardless of which branch computed the value.
  it('always returns an integer within [1, 6], regardless of the host core count', () => {
    const n = defaultComprefaceProcesses();
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// buildComprefaceRunArgs
// ---------------------------------------------------------------------------

describe('buildComprefaceRunArgs', () => {
  beforeEach(() => {
    // Fix the core-aware default so assertions on UWSGI_PROCESSES are stable
    // across hosts: 4 cores - 2 = 2.
    availableParallelismResult = 4;
  });

  it('builds the default args: restart policy, port mapping, uwsgi env, image last', () => {
    const args = buildComprefaceRunArgs(3000);

    expect(args[0]).toBe('run');
    expect(args).toEqual(expect.arrayContaining(['-d']));
    expect(args).toEqual(expect.arrayContaining(['--restart', 'unless-stopped']));
    expect(args).toEqual(expect.arrayContaining(['-p', '3000:3000']));
    expect(args).toEqual(expect.arrayContaining(['-e', 'UWSGI_PROCESSES=2']));
    expect(args).toEqual(expect.arrayContaining(['-e', 'UWSGI_THREADS=1']));
    expect(args[args.length - 1]).toBe('exadel/compreface-core:1.2.0-mobilenet');
    expect(args).not.toContain('--memory');
    expect(args).not.toContain('--cpus');
  });

  it('uses an explicit processes count when provided', () => {
    const args = buildComprefaceRunArgs(3000, { processes: 6 });
    expect(args).toEqual(expect.arrayContaining(['-e', 'UWSGI_PROCESSES=6']));
  });

  it('includes --memory and --cpus only when provided, image still last', () => {
    const args = buildComprefaceRunArgs(3000, { memory: '4g', cpus: '4' });
    expect(args).toEqual(expect.arrayContaining(['--memory', '4g']));
    expect(args).toEqual(expect.arrayContaining(['--cpus', '4']));
    expect(args[args.length - 1]).toBe('exadel/compreface-core:1.2.0-mobilenet');
  });

  it('omits --memory/--cpus entirely when not provided', () => {
    const args = buildComprefaceRunArgs(3000);
    expect(args.includes('--memory')).toBe(false);
    expect(args.includes('--cpus')).toBe(false);
  });

  it('floors and clamps processes/threads to a minimum of 1', () => {
    const args = buildComprefaceRunArgs(3000, { processes: 0.4, threads: -3 });
    expect(args).toEqual(expect.arrayContaining(['-e', 'UWSGI_PROCESSES=1']));
    expect(args).toEqual(expect.arrayContaining(['-e', 'UWSGI_THREADS=1']));
  });
});

// ---------------------------------------------------------------------------
// verifyCompreface
// ---------------------------------------------------------------------------

describe('verifyCompreface', () => {
  it('succeeds immediately when the first attempt reports available', async () => {
    mockTestCompreface.mockResolvedValue({ available: true, detail: 'ok' });

    const res = await verifyCompreface('http://localhost:3000', { retries: 5, retryDelayMs: 1 });

    expect(res.status).toBe('installed');
    expect(mockTestCompreface).toHaveBeenCalledTimes(1);
  });

  it('retries and succeeds on a later attempt (not the first)', async () => {
    mockTestCompreface
      .mockResolvedValueOnce({ available: false, detail: 'not ready' })
      .mockResolvedValueOnce({ available: false, detail: 'not ready' })
      .mockResolvedValueOnce({ available: true, detail: 'ready now' });

    const res = await verifyCompreface('http://localhost:3000', { retries: 5, retryDelayMs: 1 });

    expect(res.status).toBe('installed');
    expect(mockTestCompreface).toHaveBeenCalledTimes(3);
  });

  it('gives up and reports failed after exhausting all retries', async () => {
    mockTestCompreface.mockResolvedValue({ available: false, detail: 'still not ready' });

    const res = await verifyCompreface('http://localhost:3000', { retries: 3, retryDelayMs: 1 });

    expect(res.status).toBe('failed');
    expect(mockTestCompreface).toHaveBeenCalledTimes(3);
    expect(res.detail).toMatch(/still not ready/);
  });
});

// ---------------------------------------------------------------------------
// ensureModelsIfConfigured
// ---------------------------------------------------------------------------

describe('ensureModelsIfConfigured', () => {
  it('skips gracefully when not logged in', async () => {
    mockLoadConfig.mockReturnValue(null);

    const res = await ensureModelsIfConfigured();

    expect(res.status).toBe('skipped');
    expect(res.detail).toMatch(/Not logged in/);
    expect(mockApiClientCtor).not.toHaveBeenCalled();
  });

  it('skips when the server manifest lists no model files', async () => {
    mockLoadConfig.mockReturnValue({ serverUrl: 'https://api.example.com', pat: 'pat_123' });
    mockGetModelManifest.mockResolvedValue([]);

    const res = await ensureModelsIfConfigured();

    expect(res.status).toBe('skipped');
    expect(mockEnsureModels).not.toHaveBeenCalled();
  });

  it('reports installed when files were downloaded', async () => {
    mockLoadConfig.mockReturnValue({ serverUrl: 'https://api.example.com', pat: 'pat_123' });
    mockGetModelManifest.mockResolvedValue([{ name: 'model.onnx' }]);
    mockEnsureModels.mockResolvedValue({
      targetDir: '/home/user/.memoriahub/models',
      downloaded: ['model.onnx'],
      present: [],
      failed: [],
    });

    const res = await ensureModelsIfConfigured();

    expect(res.status).toBe('installed');
  });

  it('reports failed when a model file fails to download', async () => {
    mockLoadConfig.mockReturnValue({ serverUrl: 'https://api.example.com', pat: 'pat_123' });
    mockGetModelManifest.mockResolvedValue([{ name: 'model.onnx' }]);
    mockEnsureModels.mockResolvedValue({
      targetDir: '/home/user/.memoriahub/models',
      downloaded: [],
      present: [],
      failed: [{ name: 'model.onnx', error: 'checksum mismatch' }],
    });

    const res = await ensureModelsIfConfigured();

    expect(res.status).toBe('failed');
    expect(res.detail).toMatch(/checksum mismatch/);
  });

  it('reports failed when the manifest fetch throws', async () => {
    mockLoadConfig.mockReturnValue({ serverUrl: 'https://api.example.com', pat: 'pat_123' });
    mockGetModelManifest.mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await ensureModelsIfConfigured();

    expect(res.status).toBe('failed');
    expect(res.detail).toMatch(/ECONNREFUSED/);
  });
});
