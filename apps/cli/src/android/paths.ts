/**
 * android/paths.ts — where the Android pieces live (issue #517).
 *
 * Two roots that must not be confused:
 *
 *   - the REPOSITORY root, holding `apps/android` (sources, gradlew,
 *     version.properties) and receiving `dist/android/` build outputs. An
 *     installed CLI (root `install.sh` ships only `dist/`) has NO checkout, so
 *     every command that needs one resolves it explicitly, in this order:
 *       1. `--repo <path>`            (global option on `memoriahub android`)
 *       2. `MEMORIAHUB_REPO_ROOT`
 *       3. walk up from the cwd to the nearest ancestor containing
 *          `apps/android/version.properties`
 *     and fails with exit code 6 and a "clone the repo" message otherwise.
 *
 *   - the per-user STATE directory `~/.memoriahub/android/` (mode 0700,
 *     honouring `MEMORIAHUB_STATE_DIR`), holding the release keystore and its
 *     passwords — deliberately outside every checkout so no `git add -A` can
 *     ever pick them up.
 */

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { PreconditionError } from './errors.js';

/** Point the android commands at a checkout explicitly. */
export const REPO_ROOT_ENV_VAR = 'MEMORIAHUB_REPO_ROOT';

/** Extra arguments appended to every Gradle invocation (e.g. `--max-workers=1`). */
export const GRADLE_ARGS_ENV_VAR = 'MEMORIAHUB_GRADLE_ARGS';

/** Relocates the whole `~/.memoriahub` tree (same variable as `paths.ts`). */
export const STATE_DIR_ENV_VAR = 'MEMORIAHUB_STATE_DIR';

export const ANDROID_APP_DIR = join('apps', 'android');

/** The marker file that identifies a MemoriaHub checkout. */
export const VERSION_PROPERTIES_REL = join(ANDROID_APP_DIR, 'version.properties');

export const CLONE_URL = 'https://github.com/marinoscar/MemoriaHub.git';

export const NO_CHECKOUT_MESSAGE =
  `No MemoriaHub checkout found. Clone the repo (\`git clone ${CLONE_URL}\`) and run from inside it, ` +
  'or pass `--repo <path>`.';

export interface AndroidPathsContext {
  /** `--repo <path>`; wins over everything else. */
  repo?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  home?: string | undefined;
  cwd?: string | undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export type RepoRootSource = 'flag' | 'env' | 'cwd';

export interface RepoRootResolution {
  root: string | undefined;
  source: RepoRootSource | undefined;
  /** Why an explicit `--repo`/env value was rejected. */
  rejected?: string | undefined;
}

/**
 * Resolve the checkout. An explicit `--repo` or `MEMORIAHUB_REPO_ROOT` that
 * does not hold `apps/android/version.properties` is an error (reported in
 * `rejected`), never silently replaced by the cwd walk: the user asked for a
 * specific checkout.
 */
export function resolveRepoRoot(ctx: AndroidPathsContext = {}): RepoRootResolution {
  const env = ctx.env ?? process.env;
  const cwd = ctx.cwd ?? process.cwd();

  const explicit: Array<[RepoRootSource, string | undefined, string]> = [
    ['flag', ctx.repo, '--repo'],
    ['env', env[REPO_ROOT_ENV_VAR], REPO_ROOT_ENV_VAR],
  ];
  for (const [source, raw, name] of explicit) {
    if (raw === undefined || raw.trim() === '') continue;
    const root = resolve(cwd, raw.trim());
    if (isFile(join(root, VERSION_PROPERTIES_REL))) return { root, source };
    return { root: undefined, source, rejected: `${name} ${root} has no ${VERSION_PROPERTIES_REL}.` };
  }

  let current = resolve(cwd);
  for (;;) {
    if (isFile(join(current, VERSION_PROPERTIES_REL))) return { root: current, source: 'cwd' };
    const parent = dirname(current);
    if (parent === current) return { root: undefined, source: undefined };
    current = parent;
  }
}

/** The checkout, or `undefined` (doctor reports it as a check). */
export function findRepoRoot(ctx: AndroidPathsContext = {}): string | undefined {
  return resolveRepoRoot(ctx).root;
}

/** The checkout, or a PreconditionError (exit 6) saying how to get one. */
export function requireRepoRoot(ctx: AndroidPathsContext = {}): string {
  const resolution = resolveRepoRoot(ctx);
  if (resolution.root === undefined) {
    throw new PreconditionError(
      resolution.rejected === undefined ? NO_CHECKOUT_MESSAGE : `${resolution.rejected} ${NO_CHECKOUT_MESSAGE}`,
    );
  }
  return resolution.root;
}

export function androidProjectDir(repoRoot: string): string {
  return join(repoRoot, ANDROID_APP_DIR);
}

export function versionPropertiesPath(repoRoot: string): string {
  return join(repoRoot, VERSION_PROPERTIES_REL);
}

export function identityPropertiesPath(repoRoot: string): string {
  return join(androidProjectDir(repoRoot), 'identity.properties');
}

export function distDir(repoRoot: string): string {
  return join(repoRoot, 'dist', 'android');
}

/** `~/.memoriahub`, or `MEMORIAHUB_STATE_DIR` (mirrors `paths.ts#configDir`, injectable for tests). */
export function stateDir(ctx: AndroidPathsContext = {}): string {
  const env = ctx.env ?? process.env;
  const override = env[STATE_DIR_ENV_VAR]?.trim();
  if (override) return resolve(override);
  return join(ctx.home ?? homedir(), '.memoriahub');
}

/** `~/.memoriahub/android` — keystore and signing passwords. */
export function androidStateDir(ctx: AndroidPathsContext = {}): string {
  return join(stateDir(ctx), 'android');
}

/** `~/.memoriahub/android-sdk` — where `doctor --fix` installs the SDK. */
export function managedSdkDir(ctx: AndroidPathsContext = {}): string {
  return join(stateDir(ctx), 'android-sdk');
}

/** Split `MEMORIAHUB_GRADLE_ARGS` on whitespace, honouring simple quotes. */
export function extraGradleArgs(env: NodeJS.ProcessEnv): string[] {
  const raw = env[GRADLE_ARGS_ENV_VAR];
  if (raw === undefined || raw.trim() === '') return [];
  const args: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return args;
}
