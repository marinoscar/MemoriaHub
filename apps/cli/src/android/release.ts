/**
 * android/release.ts — `memoriahub android release` (issue #517).
 *
 *   1. PRE-CHECKS, before anything changes: the checkout, the doctor
 *      essentials (JDK, SDK, keystore), a login with system_settings:write,
 *      and that the post-bump versionCode is above the server's current
 *      release (404 NO_RELEASE = nothing published). Re-running with no
 *      changes is refused here ("not newer — pass `--bump`").
 *   2. bump (only with `--bump`) → build → publish as current (the server
 *      auto-trusts the signer in assetlinks).
 *   3. `git commit -- apps/android/version.properties` unless `--no-commit`
 *      (never pushed).
 *
 * The commit comes LAST so a failed build or a rejected upload never leaves a
 * "release x.y.z" commit for a release that does not exist; the bump stays in
 * the working tree and the error says how to retry WITHOUT bumping again.
 */

import { relative } from 'node:path';

import { failed, type AndroidCheckId, type AndroidDoctorReport } from './doctor.js';
import { AndroidCliError, PreconditionError, errorMessage, exitCodeFor, type ExitCode } from './errors.js';
import type { ExecFn } from './exec.js';
import type { AndroidRelease, CurrentUser, ServerCredentials } from './publish.js';
import { versionPropertiesPath } from './paths.js';
import { previewBump, readVersion, versionLabel, type AppVersion, type BumpPart } from './version.js';

/** Doctor rows a release cannot do without. */
export const RELEASE_ESSENTIALS: readonly AndroidCheckId[] = [
  'repo',
  'gradlew',
  'version',
  'jdk',
  'sdk',
  'platform-tools',
  'platform',
  'build-tools',
  'apksigner',
  'keystore',
  'fingerprint',
];

/** The essentials that are not passing, as one actionable message (or undefined). */
export function essentialsProblem(report: AndroidDoctorReport): string | undefined {
  const broken = report.checks.filter(
    (check) => RELEASE_ESSENTIALS.includes(check.id) && (check.status === 'fail' || (check.id === 'keystore' && check.status !== 'pass')),
  );
  if (broken.length === 0) return undefined;
  const lines = broken.map((check) => `  ✗ ${check.label}: ${check.detail}${check.fix === undefined ? '' : ` → ${check.fix}`}`);
  return `The Android toolchain is not ready for a release:\n${lines.join('\n')}`;
}

export interface ReleasePlan {
  before: AppVersion;
  after: AppVersion;
  bumped: boolean;
  current: AndroidRelease | null;
  credentials: ServerCredentials;
  user: CurrentUser;
}

export interface PrecheckDeps {
  repoRoot: string;
  packageName: string;
  part: BumpPart | undefined;
  doctor: () => Promise<AndroidDoctorReport>;
  credentials: () => ServerCredentials;
  requirePermission: (credentials: ServerCredentials) => Promise<CurrentUser>;
  latest: (credentials: ServerCredentials) => Promise<AndroidRelease | null>;
}

/** Everything that can refuse a release, BEFORE anything is written. */
export async function releasePrechecks(deps: PrecheckDeps): Promise<ReleasePlan> {
  const report = await deps.doctor();
  const problem = essentialsProblem(report);
  if (problem !== undefined) throw new PreconditionError(problem);
  if (failed(report, 'repo')) throw new PreconditionError('No MemoriaHub checkout.');

  const credentials = deps.credentials();
  const user = await deps.requirePermission(credentials);
  const current = await deps.latest(credentials);

  const file = versionPropertiesPath(deps.repoRoot);
  const { before, after } =
    deps.part === undefined
      ? (() => {
          const version = readVersion(file);
          const same = { versionName: version.versionName, versionCode: version.versionCode };
          return { before: same, after: same };
        })()
      : previewBump(file, deps.part);

  if (current !== null && current.packageName === deps.packageName && after.versionCode <= current.versionCode) {
    throw new PreconditionError(
      deps.part === undefined
        ? `Local ${versionLabel(after)} is not newer than the server's current release ` +
            `${versionLabel(current)} on ${credentials.serverUrl} — pass \`--bump patch|minor|major\`.`
        : `Even after --bump ${deps.part}, ${versionLabel(after)} is not newer than the server's current release ` +
            `${versionLabel(current)}. Set a higher code with \`memoriahub android version --code ${current.versionCode + 1}\`.`,
    );
  }
  return { before, after, bumped: deps.part !== undefined, current, credentials, user };
}

export interface ReleaseSteps<TBuild, TRelease> {
  bump(): AppVersion;
  build(): Promise<TBuild>;
  publish(build: TBuild): Promise<TRelease>;
  /** Returns a sentence for the log, e.g. the commit SHA or why it was skipped. */
  commit(version: AppVersion): Promise<string>;
}

export interface ReleaseOutcome<TBuild, TRelease> {
  version: AppVersion;
  build: TBuild;
  release: TRelease;
  commit: string;
}

/** A step failed after the version was (possibly) bumped; the message says how to retry. */
export class ReleaseStepError extends AndroidCliError {
  constructor(message: string, cause: unknown) {
    super(message, exitCodeFor(cause) as ExitCode, { cause });
  }
}

export async function runRelease<TBuild, TRelease>(
  plan: Pick<ReleasePlan, 'after' | 'bumped'>,
  options: { commit: boolean },
  steps: ReleaseSteps<TBuild, TRelease>,
  log: (line: string) => void,
): Promise<ReleaseOutcome<TBuild, TRelease>> {
  const version = plan.bumped ? steps.bump() : plan.after;
  log(plan.bumped ? `Version bumped to ${versionLabel(version)}.` : `Releasing ${versionLabel(version)} (no bump).`);

  const failAfter = (step: string, error: unknown): never => {
    const state = plan.bumped
      ? `apps/android/version.properties was bumped locally to ${versionLabel(version)} and NOT committed. `
      : '';
    throw new ReleaseStepError(
      `${step} failed: ${errorMessage(error)}\n${state}` +
        'Fix the problem, then retry WITHOUT bumping again: `memoriahub android build && memoriahub android publish`' +
        (plan.bumped ? ' (and commit version.properties).' : '.'),
      error,
    );
  };

  let build: TBuild;
  try {
    build = await steps.build();
  } catch (error) {
    return failAfter('Build', error);
  }
  log('Build: done.');

  let release: TRelease;
  try {
    release = await steps.publish(build);
  } catch (error) {
    return failAfter('Publish', error);
  }
  log('Publish: done.');

  const commit = !options.commit
    ? 'skipped (--no-commit)'
    : plan.bumped
      ? await steps.commit(version)
      : 'skipped (version.properties unchanged)';
  return { version, build, release, commit };
}

export function releaseCommitMessage(version: AppVersion): string {
  return `chore(android): release ${version.versionName} (${version.versionCode})`;
}

/** Commit ONLY version.properties (`git commit -- <path>`): whatever else is staged stays out. */
export async function commitVersionFile(exec: ExecFn, repoRoot: string, version: AppVersion): Promise<string> {
  const inRepo = await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoRoot }).catch(() => undefined);
  if (inRepo === undefined || inRepo.code !== 0 || inRepo.stdout.trim() !== 'true') {
    return 'skipped (not a git repository)';
  }
  const file = relative(repoRoot, versionPropertiesPath(repoRoot)).split('\\').join('/');
  const commit = await exec('git', ['commit', '-m', releaseCommitMessage(version), '--', file], { cwd: repoRoot });
  if (commit.code !== 0) return `not committed: ${(commit.stderr.trim() || commit.stdout.trim()).split('\n')[0]}`;
  const sha = await exec('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot });
  return `committed ${sha.stdout.trim()} "${releaseCommitMessage(version)}" (not pushed)`;
}
