import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runAndroidDoctor, type AndroidDoctorReport } from '../../src/android/doctor.js';
import { PreconditionError } from '../../src/android/errors.js';
import { exec as realExec } from '../../src/android/exec.js';
import type { AndroidRelease } from '../../src/android/publish.js';
import {
  commitVersionFile,
  essentialsProblem,
  releaseCommitMessage,
  releasePrechecks,
  runRelease,
  type PrecheckDeps,
} from '../../src/android/release.js';
import { cleanupTemp, envFor, fakeExec, makeRepo, makeSdk, makeState, tempDir, toolchain } from './fixtures.js';

afterEach(cleanupTemp);

const versionFile = (repo: string) => join(repo, 'apps', 'android', 'version.properties');

async function healthyReport(repo: string, keystore = true): Promise<AndroidDoctorReport> {
  return await runAndroidDoctor({ cwd: repo, env: envFor(makeState(keystore), makeSdk()), home: tempDir(), exec: fakeExec(toolchain()).exec, platform: 'linux' });
}

const current = (versionCode: number, packageName = 'memoriahub.marin.cr') =>
  ({ id: 'r1', packageName, versionName: '2.0.0', versionCode, fileSha256: 'c', sizeBytes: '1', createdAt: '2026-10-01T00:00:00Z' }) as AndroidRelease;

function deps(repo: string, overrides: Partial<PrecheckDeps> = {}): PrecheckDeps & { order: string[] } {
  const order: string[] = [];
  return {
    order,
    repoRoot: repo,
    packageName: 'memoriahub.marin.cr',
    part: 'patch',
    doctor: async () => {
      order.push('doctor');
      return await healthyReport(repo);
    },
    credentials: () => {
      order.push('credentials');
      return { serverUrl: 'https://photos.example', token: 't' };
    },
    requirePermission: async () => {
      order.push('permission');
      return { email: 'admin@x', permissions: ['system_settings:write'] };
    },
    latest: async () => {
      order.push('latest');
      return current(100);
    },
    ...overrides,
  };
}

describe('android release pre-checks (before any bump)', () => {
  it('passes and previews the bump without writing it', async () => {
    const repo = makeRepo();
    const d = deps(repo);
    const plan = await releasePrechecks(d);
    expect(d.order).toEqual(['doctor', 'credentials', 'permission', 'latest']);
    expect(plan).toMatchObject({ before: { versionCode: 100 }, after: { versionName: '2.0.1', versionCode: 101 }, bumped: true });
    expect(readFileSync(versionFile(repo), 'utf8')).toContain('versionCode=100');
  });

  it('refuses a not-newer local version without --bump ("pass --bump") and writes nothing', async () => {
    const repo = makeRepo();
    const before = readFileSync(versionFile(repo), 'utf8');
    await expect(releasePrechecks(deps(repo, { part: undefined }))).rejects.toThrow(/not newer .* pass `--bump/);
    expect(readFileSync(versionFile(repo), 'utf8')).toBe(before);
  });

  it('refuses when even the bumped code is not above the server', async () => {
    const repo = makeRepo();
    await expect(releasePrechecks(deps(repo, { latest: async () => current(500) }))).rejects.toThrow(/--code 501/);
  });

  it('releases the current version without a bump when it is already newer, or when nothing is published', async () => {
    const repo = makeRepo();
    expect(await releasePrechecks(deps(repo, { part: undefined, latest: async () => current(99) }))).toMatchObject({ bumped: false, after: { versionCode: 100 } });
    expect(await releasePrechecks(deps(repo, { part: undefined, latest: async () => null }))).toMatchObject({ bumped: false });
    // A current release of another package (a hand-uploaded debug build) does not block.
    expect(await releasePrechecks(deps(repo, { part: undefined, latest: async () => current(900, 'memoriahub.marin.cr.debug') }))).toMatchObject({ bumped: false });
  });

  it('stops at the toolchain (no keystore) before touching the server', async () => {
    const repo = makeRepo();
    const d = deps(repo, { doctor: async () => await healthyReport(repo, false) });
    await expect(releasePrechecks(d)).rejects.toBeInstanceOf(PreconditionError);
    await expect(releasePrechecks(deps(repo, { doctor: async () => await healthyReport(repo, false) }))).rejects.toThrow(/Release keystore/);
    expect(d.order).toEqual([]);
  });

  it('stops when the login cannot publish', async () => {
    const repo = makeRepo();
    const d = deps(repo, {
      requirePermission: async () => {
        throw new PreconditionError('lacks system_settings:write');
      },
    });
    await expect(releasePrechecks(d)).rejects.toThrow(/lacks system_settings:write/);
  });

  it('essentialsProblem lists each broken essential with its fix', async () => {
    const repo = makeRepo();
    expect(essentialsProblem(await healthyReport(repo))).toBeUndefined();
    expect(essentialsProblem(await healthyReport(repo, false))).toMatch(/Release keystore: Not configured/);
  });
});

describe('android release orchestration', () => {
  const plan = { after: { versionName: '2.0.1', versionCode: 101 }, bumped: true };

  it('bumps, builds, publishes, then commits — in that order', async () => {
    const order: string[] = [];
    const outcome = await runRelease(plan, { commit: true }, {
      bump: () => (order.push('bump'), plan.after),
      build: async () => (order.push('build'), 'apk'),
      publish: async () => (order.push('publish'), 'release'),
      commit: async () => (order.push('commit'), 'committed abc'),
    }, () => {});
    expect(order).toEqual(['bump', 'build', 'publish', 'commit']);
    expect(outcome.commit).toBe('committed abc');
  });

  it('a failed build after the bump says how to retry without bumping again, and never commits', async () => {
    const order: string[] = [];
    await expect(
      runRelease(plan, { commit: true }, {
        bump: () => plan.after,
        build: async () => {
          throw new PreconditionError('Gradle exploded');
        },
        publish: async () => 'never',
        commit: async () => (order.push('commit'), ''),
      }, () => {}),
    ).rejects.toThrow(/Build failed: Gradle exploded\n.*NOT committed.*`memoriahub android build && memoriahub android publish`/s);
    expect(order).toEqual([]);
  });

  it('--no-commit and an unbumped release skip the commit', async () => {
    const steps = { bump: () => plan.after, build: async () => 'a', publish: async () => 'r', commit: async () => 'committed' };
    expect((await runRelease(plan, { commit: false }, steps, () => {})).commit).toBe('skipped (--no-commit)');
    expect((await runRelease({ ...plan, bumped: false }, { commit: true }, steps, () => {})).commit).toBe('skipped (version.properties unchanged)');
  });

  it('commits ONLY version.properties, leaving other staged changes alone', async () => {
    const repo = makeRepo();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    git('-c', 'user.email=t@x', '-c', 'user.name=t', 'add', '.');
    git('-c', 'user.email=t@x', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
    git('config', 'user.email', 't@x');
    git('config', 'user.name', 't');
    writeFileSync(versionFile(repo), 'versionName=2.0.1\nversionCode=101\n');
    writeFileSync(join(repo, 'other.txt'), 'staged');
    git('add', 'other.txt');

    const result = await commitVersionFile(realExec, repo, plan.after);
    expect(result).toMatch(/^committed [0-9a-f]+ "chore\(android\): release 2\.0\.1 \(101\)" \(not pushed\)$/);
    expect(git('log', '-1', '--name-only', '--format=%s')).toBe(`${releaseCommitMessage(plan.after)}\n\napps/android/version.properties\n`);
    expect(git('diff', '--cached', '--name-only')).toBe('other.txt\n');
  });
});
