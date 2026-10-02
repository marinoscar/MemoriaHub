import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { androidCommand, type AndroidCommandContext } from '../../src/commands/android.js';
import type { ProbeRunner, SudoRunner } from '../../src/android/fix-plan.js';
import { cleanupTemp, envFor, fakeExec, makeRepo, makeSdk, makeState, SHA_HEX, tempDir, toolchain, type Responder } from './fixtures.js';
import { multipartFieldOrder, reasonError, release, startMockServer, type MockServer } from './mock-server.js';

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  cleanupTemp();
});

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

async function run(args: string[], ctx: AndroidCommandContext): Promise<Run> {
  let stdout = '';
  let stderr = '';
  let code = 0;
  const command = androidCommand({
    ...ctx,
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    onExit: (value) => {
      code = value;
    },
  });
  command.exitOverride();
  await command.parseAsync(args, { from: 'user' });
  return { stdout, stderr, code };
}

describe('memoriahub android version', () => {
  it('prints the version, bumps it (code + 1) and honours --repo after the subcommand', async () => {
    const repo = makeRepo();
    const ctx = { cwd: tempDir(), env: {} };
    expect((await run(['--repo', repo, 'version'], ctx)).stdout).toBe('2.0.0 (100)\n');
    const bumped = await run(['version', '--bump', 'patch', '--json', '--repo', repo], ctx);
    expect(JSON.parse(bumped.stdout)).toEqual({ versionName: '2.0.1', versionCode: 101 });
    expect(readFileSync(join(repo, 'apps', 'android', 'version.properties'), 'utf8')).toContain('versionCode=101');
    expect((await run(['--repo', repo, 'version', '--code', '50'], ctx)).code).toBe(2);
  });

  it('exits 6 with the clone message outside a checkout', async () => {
    const result = await run(['version'], { cwd: tempDir(), env: {} });
    expect(result.code).toBe(6);
    expect(result.stderr).toContain('No MemoriaHub checkout found. Clone the repo');
  });
});

describe('memoriahub android doctor', () => {
  const brokenJdk: Responder = (command, args, options) =>
    command === 'java' ? { stderr: 'openjdk version "11.0.2"' } : toolchain()(command, args, options);

  function fixSeams() {
    const sudoCalls: string[][] = [];
    const sudo: SudoRunner = async (cmd, args) => {
      sudoCalls.push([cmd, ...args]);
      return { ok: true, stdout: '', stderr: '' };
    };
    const probe: ProbeRunner = async () => ({ code: 0, stdout: 'Package: openjdk-17-jdk-headless\n', stderr: '' });
    return { sudoCalls, sudo, probe, linuxFamily: () => 'debian' as const, isRoot: () => false, platform: 'linux' as const };
  }

  it('--dry-run prints the plan and executes nothing', async () => {
    const seams = fixSeams();
    const { exec, calls } = fakeExec(brokenJdk);
    const result = await run(['doctor', '--dry-run'], {
      cwd: makeRepo(),
      env: envFor(makeState(), join(tempDir(), 'no-sdk')),
      home: tempDir(),
      exec,
      credentials: () => undefined,
      ...seams,
    });
    expect(result.stderr).toContain('sudo apt-get install -y openjdk-17-jdk-headless');
    expect(result.stderr).toContain('commandlinetools-linux-13114758_latest.zip');
    expect(result.stderr).toContain('Dry run: nothing was executed.');
    expect(seams.sudoCalls).toEqual([]);
    expect(calls.every((call) => call.command === 'java' || call.command === 'keytool')).toBe(true);
    expect(result.code).toBe(6);
  });

  it('--fix without --yes in a non-interactive shell prints the plan and does not run it', async () => {
    const seams = fixSeams();
    const result = await run(['doctor', '--fix'], {
      cwd: makeRepo(),
      env: envFor(makeState(), makeSdk()),
      home: tempDir(),
      exec: fakeExec(brokenJdk).exec,
      credentials: () => undefined,
      ...seams,
    });
    expect(result.stderr).toContain('pass --yes');
    expect(seams.sudoCalls).toEqual([]);
  });

  it('--fix --yes installs the JDK through the announced sudo runner', async () => {
    const seams = fixSeams();
    await run(['doctor', '--fix', '--yes'], {
      cwd: makeRepo(),
      env: envFor(makeState(), makeSdk()),
      home: tempDir(),
      exec: fakeExec(brokenJdk).exec,
      credentials: () => undefined,
      ...seams,
    });
    expect(seams.sudoCalls).toEqual([['apt-get', 'update'], ['apt-get', 'install', '-y', 'openjdk-17-jdk-headless']]);
  });

  it('--fix with an interactive "no" runs nothing', async () => {
    const seams = fixSeams();
    const result = await run(['doctor', '--fix'], {
      cwd: makeRepo(),
      env: envFor(makeState(), makeSdk()),
      home: tempDir(),
      exec: fakeExec(brokenJdk).exec,
      credentials: () => undefined,
      confirm: async () => false,
      ...seams,
    });
    expect(result.stderr).toContain('Not executed.');
    expect(seams.sudoCalls).toEqual([]);
  });

  it('--json prints { ok, checks } and exits 0 when healthy', async () => {
    const result = await run(['doctor', '--json'], {
      cwd: makeRepo(),
      env: envFor(makeState(), makeSdk()),
      home: tempDir(),
      exec: fakeExec(toolchain()).exec,
      credentials: () => undefined,
    });
    const json = JSON.parse(result.stdout) as { ok: boolean; checks: Array<{ id: string; status: string }> };
    expect(json.ok).toBe(true);
    expect(json.checks.find((check) => check.id === 'login')?.status).toBe('warn');
    expect(result.code).toBe(0);
  });
});

describe('memoriahub android keystore', () => {
  it('init writes signing.json 0600 and refuses a second init', async () => {
    const state = tempDir();
    const { exec } = fakeExec((command, args) => {
      if (command === 'keytool' && args[0] === '-genkeypair') {
        writeFileSync(args[args.indexOf('-keystore') + 1] as string, 'jks');
        return {};
      }
      return toolchain()(command, args, undefined);
    });
    const ctx = { cwd: tempDir(), env: { MEMORIAHUB_STATE_DIR: state, ANDROID_KEYSTORE_PASSWORD: 'longenough' }, exec };
    const first = await run(['keystore', 'init'], ctx);
    expect(first.code).toBe(0);
    expect(first.stderr).toContain('BACK UP THIS FILE. Losing it forces every user to uninstall and reinstall.');
    const signing = join(state, 'android', 'signing.json');
    expect(statSync(signing).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(signing, 'utf8'))).toMatchObject({ keyAlias: 'memoriahub', storePassword: 'longenough' });

    const second = await run(['keystore', 'init'], ctx);
    expect(second.code).toBe(6);
    expect(second.stderr).toContain('refusing');
  });

  it('generates a password when there is no env and no terminal', async () => {
    const state = tempDir();
    const { exec } = fakeExec((command, args) => {
      if (args[0] === '-genkeypair') writeFileSync(args[args.indexOf('-keystore') + 1] as string, 'jks');
      return toolchain()(command, args, undefined);
    });
    await run(['keystore', 'init'], { cwd: tempDir(), env: { MEMORIAHUB_STATE_DIR: state }, exec });
    expect(JSON.parse(readFileSync(join(state, 'android', 'signing.json'), 'utf8')).storePassword).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('secrets prints the four CI secrets on stdout with a warning on stderr', async () => {
    const state = makeState();
    const result = await run(['keystore', 'secrets'], { cwd: tempDir(), env: { MEMORIAHUB_STATE_DIR: state } });
    expect(result.stdout.split('\n').filter(Boolean).map((line) => line.split('=')[0])).toEqual([
      'ANDROID_KEYSTORE_BASE64',
      'ANDROID_KEYSTORE_PASSWORD',
      'ANDROID_KEY_ALIAS',
      'ANDROID_KEY_PASSWORD',
    ]);
    expect(result.stderr).toContain('WARNING');
  });
});

function builtApk(repo: string, versionName = '2.0.1', versionCode = 101): string {
  const dist = join(repo, 'dist', 'android');
  mkdirSync(dist, { recursive: true });
  const apk = join(dist, `memoriahub-android-${versionName}.apk`);
  writeFileSync(apk, 'PK\u0003\u0004apk');
  writeFileSync(
    join(dist, `memoriahub-android-${versionName}.json`),
    JSON.stringify({ packageName: 'memoriahub.marin.cr', versionName, versionCode, signingSha256: SHA_HEX, fileSha256: 'd'.repeat(64), sizeBytes: 7, builtAt: '', gitSha: null }),
  );
  return apk;
}

describe('memoriahub android publish / releases / release', () => {
  it('publish uploads the newest APK in dist/android after the permission pre-check', async () => {
    server = await startMockServer((request) =>
      request.url === '/api/auth/me'
        ? { status: 200, body: { data: { email: 'a@x', permissions: ['system_settings:write'] } } }
        : { status: 201, body: { data: release({ id: 'new-id', versionName: '2.0.1', versionCode: 101 }) } },
    );
    const repo = makeRepo();
    builtApk(repo);
    const result = await run(['publish', '--notes', 'hello'], { cwd: repo, env: {}, credentials: () => ({ serverUrl: server!.url, token: 't' }) });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('new-id\n');
    expect(server.requests.map((request) => request.url)).toEqual(['/api/auth/me', '/api/admin/android-app/releases']);
    expect(multipartFieldOrder(server.requests[1]!.body).at(-1)).toBe('apk');
  });

  it('publish without system_settings:write stops before uploading', async () => {
    server = await startMockServer(() => ({ status: 200, body: { data: { email: 'v@x', permissions: [] } } }));
    const repo = makeRepo();
    const result = await run(['publish', builtApk(repo)], { cwd: repo, env: {}, credentials: () => ({ serverUrl: server!.url, token: 't' }) });
    expect(result.code).toBe(6);
    expect(result.stderr).toContain('lacks system_settings:write');
    expect(server.requests).toHaveLength(1);
  });

  it('publish maps RELEASE_VERSION_EXISTS to the bump hint', async () => {
    server = await startMockServer((request) =>
      request.url === '/api/auth/me'
        ? { status: 200, body: { data: { permissions: ['system_settings:write'] } } }
        : reasonError(409, 'RELEASE_VERSION_EXISTS', 'Exists'),
    );
    const repo = makeRepo();
    const result = await run(['publish', builtApk(repo)], { cwd: tempDir(), env: {}, credentials: () => ({ serverUrl: server!.url, token: 't' }) });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('run `memoriahub android version --bump patch`');
  });

  it('releases current refuses a rollback to a lower code without --yes, and makes it current with it', async () => {
    const list = [release({ id: 'cur', versionCode: 101, versionName: '2.0.1' }), release({ id: 'old', versionCode: 100, isCurrent: false })];
    server = await startMockServer((request) =>
      request.method === 'GET' ? { status: 200, body: { data: list } } : { status: 200, body: { data: release({ id: 'old' }) } },
    );
    const ctx = { cwd: tempDir(), env: {}, credentials: () => ({ serverUrl: server!.url, token: 't' }) };
    const refused = await run(['releases', 'current', 'old'], ctx);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('ROLLS BACK');
    expect(server.requests.some((request) => request.method === 'POST')).toBe(false);

    const done = await run(['releases', 'current', 'old', '--yes'], ctx);
    expect(done.code).toBe(0);
    expect(server.requests.at(-1)).toMatchObject({ method: 'POST', url: '/api/admin/android-app/releases/old/make-current' });
  });

  it('release with no changes is refused before any work ("not newer — pass --bump")', async () => {
    server = await startMockServer((request) =>
      request.url === '/api/auth/me'
        ? { status: 200, body: { data: { email: 'a@x', permissions: ['system_settings:write'] } } }
        : { status: 200, body: { data: release({ versionCode: 100 }) } },
    );
    const repo = makeRepo();
    const { exec, calls } = fakeExec(toolchain());
    const result = await run(['release'], {
      cwd: repo,
      env: envFor(makeState(), makeSdk()),
      home: tempDir(),
      exec,
      platform: 'linux',
      credentials: () => ({ serverUrl: server!.url, token: 't' }),
    });
    expect(result.code).toBe(6);
    expect(result.stderr).toMatch(/not newer .*pass `--bump/);
    expect(calls.some((call) => call.command.endsWith('gradlew'))).toBe(false);
    expect(readFileSync(join(repo, 'apps', 'android', 'version.properties'), 'utf8')).toContain('versionCode=100');
  });

  it('release --bump patch: bump → build → publish as current (end to end with a fake Gradle)', async () => {
    server = await startMockServer((request) => {
      if (request.url === '/api/auth/me') return { status: 200, body: { data: { email: 'a@x', permissions: ['system_settings:write'] } } };
      if (request.url === '/api/android-app/releases/latest') return reasonError(404, 'NO_RELEASE');
      return { status: 201, body: { data: release({ id: 'rel-101', versionName: '2.0.1', versionCode: 101 }) } };
    });
    const repo = makeRepo();
    const { exec, calls } = fakeExec((command, args, options) => {
      if (command.endsWith('gradlew')) {
        const out = join(options?.cwd ?? '', 'app', 'build', 'outputs', 'apk', 'release');
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, 'app-release.apk'), 'PK\u0003\u0004');
        return {};
      }
      return toolchain()(command, args, options);
    });
    const result = await run(['release', '--bump', 'patch', '--notes', 'first', '--no-commit'], {
      cwd: repo,
      env: envFor(makeState(), makeSdk()),
      home: tempDir(),
      exec,
      platform: 'linux',
      credentials: () => ({ serverUrl: server!.url, token: 't' }),
    });
    expect(result.stderr).not.toContain('✖');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('2.0.1 (101)\n');
    expect(calls.find((call) => call.command.endsWith('gradlew'))?.args).toEqual(
      expect.arrayContaining(['assembleRelease', '-Papp.versionName=2.0.1', '-Papp.versionCode=101', `-Papp.serverUrl=${server.url}`]),
    );
    expect(server.requests.map((request) => request.url)).toEqual([
      '/api/auth/me',
      '/api/android-app/releases/latest',
      '/api/admin/android-app/releases',
    ]);
    expect(result.stderr).toContain('Commit: skipped (--no-commit)');
  });

  it('release refuses a not-logged-in machine before bumping', async () => {
    const repo = makeRepo();
    const result = await run(['release', '--bump', 'patch'], {
      cwd: repo,
      env: envFor(makeState(), makeSdk()),
      home: tempDir(),
      exec: fakeExec(toolchain()).exec,
      platform: 'linux',
      credentials: () => undefined,
    });
    expect(result.code).toBe(6);
    expect(result.stderr).toContain('Not logged in');
    expect(readFileSync(join(repo, 'apps', 'android', 'version.properties'), 'utf8')).toContain('versionCode=100');
  });
});
