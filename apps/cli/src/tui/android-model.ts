/**
 * tui/android-model.ts — what the Android screen shows and allows, as DATA (issue #517).
 *
 * Pure: no ink, no React, no filesystem, no network. `AndroidScreen.tsx`
 * renders this and performs the side effects; the tests drive the reducer.
 *
 * ⚠ EVERY REMOTE ACTION CONFIRMS, NAMES THE SERVER, AND DEFAULTS TO NO.
 * Publish, Release and Make current change what every user of a server is
 * offered; the most expensive mistake here is a correct APK published to the
 * wrong deployment. A make-current to a LOWER versionCode carries an extra
 * warning (Android refuses downgrades).
 *
 * Long-running work (doctor --fix, build, publish, release, make current) is a
 * TASK: the screen spawns this same CLI (`memoriahub android …`) as a child
 * with piped output, because Ink owns stdout/stdin. A task is described here
 * by its CLI arguments only.
 */

import { PUBLISH_PERMISSION, formatBytes, rollbackWarning, type AndroidRelease } from '../android/publish.js';
import type { ReleaseStatus } from '../android/release-status.js';
import { versionLabel, type AppVersion, type BumpPart, type VersionBump } from '../android/version.js';

export type AndroidAction = 'doctor' | 'bump' | 'build' | 'publish' | 'release' | 'releases' | 'login';

export interface ActionItem {
  action: AndroidAction;
  label: string;
  /** False: selecting it shows `reason` instead of acting. */
  enabled: boolean;
  reason?: string | undefined;
}

export interface StatusRow {
  label: string;
  value: string;
  color?: 'green' | 'yellow' | 'red' | undefined;
}

export interface Confirmation {
  title: string;
  question: string;
  lines: string[];
  /** Shown in yellow above the choice. */
  warning?: string | undefined;
  yes: string;
}

/** A child `memoriahub android …` run: its arguments after `android`, and a title. */
export interface TaskSpec {
  title: string;
  args: string[];
}

export type Back = 'menu' | 'releases';

export type Phase =
  | { kind: 'menu' }
  | { kind: 'doctor-mode' }
  | { kind: 'part'; for: 'bump' | 'release' }
  | { kind: 'notes'; for: 'publish' }
  | { kind: 'notes'; for: 'release'; part: BumpPart | undefined }
  | { kind: 'confirm'; confirmation: Confirmation; task: TaskSpec; back: Back }
  | { kind: 'task'; task: TaskSpec; running: boolean; exitCode?: number | undefined; back: Back }
  | { kind: 'releases' };

export interface ScreenState {
  phase: Phase;
  notice?: { text: string; color: 'green' | 'yellow' | 'red' } | undefined;
}

export const INITIAL_STATE: ScreenState = { phase: { kind: 'menu' } };

export type ScreenEvent =
  | { type: 'select'; item: ActionItem }
  | { type: 'doctor-mode'; mode: 'plan' | 'fix' }
  | { type: 'part'; part: BumpPart | undefined }
  | { type: 'notes'; text: string }
  | { type: 'confirm'; yes: boolean }
  | { type: 'make-current'; target: AndroidRelease; releases: readonly AndroidRelease[] }
  | { type: 'task-done'; exitCode: number }
  | { type: 'notice'; text: string; color: 'green' | 'yellow' | 'red' }
  | { type: 'back' };

/** What the reducer needs to know about the world. */
export interface ModelContext {
  status: ReleaseStatus | undefined;
  repoRoot: string | undefined;
  /** What a bump would do (reads version.properties). */
  preview: (part: BumpPart) => VersionBump;
}

// ---------------------------------------------------------------------------
// Status panel
// ---------------------------------------------------------------------------

export function loginRow(status: ReleaseStatus): StatusRow {
  const { login } = status;
  const server = login.serverUrl ?? '(no server)';
  switch (login.state) {
    case 'logged_out':
      return { label: 'Login/server', value: 'Not logged in', color: 'red' };
    case 'expired':
      return { label: 'Login/server', value: `Expired for ${server} — log in again`, color: 'red' };
    case 'logged_in': {
      const who = `${login.email ?? 'signed in'} on ${server}`;
      if (login.error !== undefined) return { label: 'Login/server', value: `${who} — could not check: ${login.error}`, color: 'yellow' };
      return login.canPublish
        ? { label: 'Login/server', value: `${who} — can publish`, color: 'green' }
        : { label: 'Login/server', value: `${who} — lacks ${PUBLISH_PERMISSION}`, color: 'yellow' };
    }
  }
}

export function statusRows(status: ReleaseStatus): StatusRow[] {
  const rows: StatusRow[] = [];
  rows.push(
    status.repoRoot === undefined
      ? { label: 'Checkout', value: 'No MemoriaHub checkout here (clone the repo or pass --repo)', color: 'red' }
      : { label: 'Checkout', value: status.repoRoot },
  );
  rows.push(
    status.local === null
      ? { label: 'Local version', value: status.repoRoot === undefined ? '—' : 'version.properties unreadable', color: 'red' }
      : { label: 'Local version', value: versionLabel(status.local) },
  );
  rows.push(
    status.keystore.configured
      ? { label: 'Keystore', value: status.keystore.sha256 ?? 'configured (fingerprint not cached)', color: 'green' }
      : { label: 'Keystore', value: status.keystore.error ?? 'Not configured — run `memoriahub android keystore init`', color: 'red' },
  );
  rows.push(loginRow(status));
  if (!status.server.reachable) {
    rows.push({ label: 'Server release', value: status.server.error ?? 'Not checked', color: 'yellow' });
    rows.push({ label: 'Newer?', value: 'Unknown', color: 'yellow' });
  } else {
    rows.push({
      label: 'Server release',
      value: status.server.current === null ? 'None published yet' : `Current ${versionLabel(status.server.current)}`,
    });
    rows.push(
      status.newerLocally
        ? { label: 'Newer?', value: 'Yes — the local version can be released', color: 'green' }
        : { label: 'Newer?', value: 'No — bump the version before releasing', color: 'yellow' },
    );
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Why the server actions are not available (each sentence names its fix), or undefined. */
export function remoteBlocker(status: ReleaseStatus): string | undefined {
  const { login } = status;
  switch (login.state) {
    case 'logged_out':
      return 'Not logged in. Choose "Log in".';
    case 'expired':
      return `The login for ${login.serverUrl ?? 'the server'} has expired. Choose "Log in".`;
    case 'logged_in':
      if (login.error !== undefined) return `Could not reach the server: ${login.error}. Press r to retry.`;
      if (!login.canPublish) return `${login.email ?? 'This account'} lacks ${PUBLISH_PERMISSION}. Choose "Log in" as an administrator.`;
      return undefined;
  }
}

const NO_CHECKOUT = 'No MemoriaHub checkout found. Run memoriahub from inside a clone of the repo.';
const NO_KEYSTORE = 'No release keystore. Run `memoriahub android keystore init` (or `keystore import <file>`).';

export function actionItems(status: ReleaseStatus | undefined): ActionItem[] {
  const loading = 'Still reading the status…';
  const local = status === undefined ? loading : status.repoRoot === undefined ? NO_CHECKOUT : undefined;
  const keystore = status === undefined ? loading : status.keystore.configured ? undefined : NO_KEYSTORE;
  const remote = status === undefined ? loading : remoteBlocker(status);
  const item = (action: AndroidAction, label: string, ...reasons: Array<string | undefined>): ActionItem => {
    const reason = reasons.find((entry) => entry !== undefined);
    return { action, label, enabled: reason === undefined, ...(reason === undefined ? {} : { reason }) };
  };
  const items: ActionItem[] = [
    item('doctor', 'Doctor  (check; plan, then fix the toolchain)'),
    item('bump', 'Bump version', local),
    item('build', 'Build  (signed release APK)', local, keystore),
    item('publish', 'Publish  (upload the built APK)', local, remote),
    item('release', 'Release  (pre-check → bump → build → publish → commit)', local, keystore, remote),
    item('releases', 'Releases  (list, make current, roll back)', remote),
  ];
  const needsLogin =
    status !== undefined && (status.login.state !== 'logged_in' || (status.login.error === undefined && !status.login.canPublish));
  if (needsLogin) items.push(item('login', 'Log in'));
  return items;
}

/** The highlighted action when the menu opens: Release. */
export function defaultActionIndex(items: readonly ActionItem[]): number {
  const index = items.findIndex((item) => item.action === 'release');
  return index === -1 ? 0 : index;
}

/** A disabled action is shown annotated, not hidden. */
export function itemLabel(item: ActionItem): string {
  return item.enabled ? item.label : `${item.label}  — unavailable`;
}

export function bumpLabel(part: BumpPart, preview: VersionBump): string {
  return `${part.padEnd(5)}  ${versionLabel(preview.before)} → ${versionLabel(preview.after)}`;
}

// ---------------------------------------------------------------------------
// Confirmations and tasks
// ---------------------------------------------------------------------------

function repoArgs(repoRoot: string | undefined): string[] {
  return repoRoot === undefined ? [] : ['--repo', repoRoot];
}

export function doctorTask(mode: 'plan' | 'fix', repoRoot: string | undefined): TaskSpec {
  return mode === 'plan'
    ? { title: 'Doctor — plan (dry run)', args: [...repoArgs(repoRoot), 'doctor', '--dry-run'] }
    : { title: 'Doctor — fix', args: [...repoArgs(repoRoot), 'doctor', '--fix', '--yes'] };
}

export function buildTask(repoRoot: string | undefined): TaskSpec {
  return { title: 'Build', args: [...repoArgs(repoRoot), 'build'] };
}

export function publishTask(repoRoot: string | undefined, notes: string): TaskSpec {
  return { title: 'Publish', args: [...repoArgs(repoRoot), 'publish', ...(notes === '' ? [] : ['--notes', notes])] };
}

export function releaseTask(repoRoot: string | undefined, part: BumpPart | undefined, notes: string): TaskSpec {
  return {
    title: 'Release',
    args: [
      ...repoArgs(repoRoot),
      'release',
      ...(part === undefined ? [] : ['--bump', part]),
      ...(notes === '' ? [] : ['--notes', notes]),
    ],
  };
}

export function makeCurrentTask(target: AndroidRelease): TaskSpec {
  return { title: 'Make current', args: ['releases', 'current', target.id, '--yes'] };
}

export function doctorFixConfirmation(): Confirmation {
  return {
    title: 'Doctor — fix',
    question: 'Install the missing toolchain pieces now?',
    lines: [
      'Runs `memoriahub android doctor --fix --yes`: the Android SDK (cmdline-tools, licences, platform, build-tools)',
      'and, on Debian/Ubuntu, a JDK through apt — every sudo command is printed before it runs.',
      'sudo cannot ask for a password here: run `sudo -v` in another shell first when it needs one.',
      'A keystore is never created by the fix.',
    ],
    yes: 'Yes, install',
  };
}

export function publishConfirmation(version: AppVersion | null, serverUrl: string, current: AndroidRelease | null, notes: string): Confirmation {
  const label = version === null ? 'the newest built APK' : `v${versionLabel(version)}`;
  const notNewer = version !== null && current !== null && version.versionCode <= current.versionCode ? current : undefined;
  return {
    title: 'Publish',
    question: `Publish ${label} to ${serverUrl}?`,
    lines: [
      'It becomes the current release: the download page offers it and paired phones are told to update.',
      ...(notes === '' ? [] : [`Notes: ${notes}`]),
    ],
    ...(notNewer !== undefined
      ? { warning: `The server's current release is ${versionLabel(notNewer)}; the server refuses an upload that is not newer. Bump and build again.` }
      : {}),
    yes: 'Yes, publish',
  };
}

export function releaseConfirmation(before: AppVersion, after: AppVersion, bumped: boolean, serverUrl: string, notes: string): Confirmation {
  return {
    title: 'Release',
    question: `Release v${versionLabel(after)} to ${serverUrl}?`,
    lines: [
      '1. Pre-check the toolchain, the login and that it is newer than the server (nothing changes if one fails)',
      bumped ? `2. Bump version.properties ${versionLabel(before)} → ${versionLabel(after)}` : '2. No bump: release the current version',
      '3. Build and sign the release APK',
      `4. Publish it to ${serverUrl} as the current release`,
      bumped ? '5. Commit version.properties (only that file; not pushed)' : '5. Nothing to commit',
      ...(notes === '' ? [] : [`Notes: ${notes}`]),
    ],
    yes: 'Yes, release',
  };
}

export function makeCurrentConfirmation(target: AndroidRelease, releases: readonly AndroidRelease[], serverUrl: string): Confirmation {
  const current = releases.find((release) => release.isCurrent === true);
  const warning = rollbackWarning(target, current);
  return {
    title: 'Make current',
    question: `Make v${versionLabel(target)} the current release on ${serverUrl}?`,
    lines: [current === undefined ? 'No release is current now.' : `Current now: ${versionLabel(current)}.`],
    ...(warning === undefined ? {} : { warning }),
    yes: warning === undefined ? 'Yes, make it current' : 'Yes, roll back',
  };
}

export function releaseLabel(release: AndroidRelease): string {
  const marker = release.isCurrent === true ? '*' : ' ';
  const when = release.createdAt.slice(0, 16).replace('T', ' ');
  return `${marker} ${release.versionName.padEnd(10)} code ${String(release.versionCode).padEnd(10)} ${formatBytes(release.sizeBytes).padStart(9)}  ${when}`;
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

function serverOf(ctx: ModelContext): string {
  return ctx.status?.login.serverUrl ?? '(no server)';
}

export function reduce(state: ScreenState, event: ScreenEvent, ctx: ModelContext): ScreenState {
  const phase = state.phase;
  switch (event.type) {
    case 'notice':
      return { ...state, notice: { text: event.text, color: event.color } };

    case 'select': {
      if (phase.kind !== 'menu') return state;
      const { item } = event;
      if (!item.enabled) return { ...state, notice: { text: item.reason ?? 'Not available.', color: 'yellow' } };
      switch (item.action) {
        case 'doctor':
          return { phase: { kind: 'doctor-mode' } };
        case 'bump':
          return { phase: { kind: 'part', for: 'bump' } };
        case 'build':
          return { phase: { kind: 'task', task: buildTask(ctx.repoRoot), running: true, back: 'menu' } };
        case 'publish':
          return { phase: { kind: 'notes', for: 'publish' } };
        case 'release':
          return { phase: { kind: 'part', for: 'release' } };
        case 'releases':
          return { phase: { kind: 'releases' } };
        case 'login':
          // The screen opens the login screen, which returns here.
          return state;
      }
      return state;
    }

    case 'doctor-mode':
      if (phase.kind !== 'doctor-mode') return state;
      return event.mode === 'plan'
        ? { phase: { kind: 'task', task: doctorTask('plan', ctx.repoRoot), running: true, back: 'menu' } }
        : { phase: { kind: 'confirm', confirmation: doctorFixConfirmation(), task: doctorTask('fix', ctx.repoRoot), back: 'menu' } };

    case 'part':
      if (phase.kind !== 'part') return state;
      if (phase.for === 'bump') {
        // The screen performs the (local, instant) bump itself and reports it as a notice.
        return { phase: { kind: 'menu' }, notice: state.notice };
      }
      return { phase: { kind: 'notes', for: 'release', part: event.part } };

    case 'notes': {
      if (phase.kind !== 'notes') return state;
      const notes = event.text.trim();
      const server = serverOf(ctx);
      if (phase.for === 'publish') {
        return {
          phase: {
            kind: 'confirm',
            confirmation: publishConfirmation(ctx.status?.local ?? null, server, ctx.status?.server.current ?? null, notes),
            task: publishTask(ctx.repoRoot, notes),
            back: 'menu',
          },
        };
      }
      const local = ctx.status?.local ?? null;
      const preview = phase.part === undefined ? undefined : ctx.preview(phase.part);
      const before = preview?.before ?? local ?? { versionName: '?', versionCode: 0 };
      const after = preview?.after ?? before;
      return {
        phase: {
          kind: 'confirm',
          confirmation: releaseConfirmation(before, after, phase.part !== undefined, server, notes),
          task: releaseTask(ctx.repoRoot, phase.part, notes),
          back: 'menu',
        },
      };
    }

    case 'make-current':
      if (phase.kind !== 'releases') return state;
      if (event.target.isCurrent === true) {
        return { ...state, notice: { text: `${versionLabel(event.target)} is already the current release.`, color: 'yellow' } };
      }
      return {
        phase: {
          kind: 'confirm',
          confirmation: makeCurrentConfirmation(event.target, event.releases, serverOf(ctx)),
          task: makeCurrentTask(event.target),
          back: 'releases',
        },
      };

    case 'confirm':
      if (phase.kind !== 'confirm') return state;
      return event.yes
        ? { phase: { kind: 'task', task: phase.task, running: true, back: phase.back } }
        : { phase: phase.back === 'releases' ? { kind: 'releases' } : { kind: 'menu' } };

    case 'task-done':
      if (phase.kind !== 'task' || !phase.running) return state;
      return { phase: { ...phase, running: false, exitCode: event.exitCode } };

    case 'back':
      if (phase.kind === 'task') {
        if (phase.running) return state; // a running task cannot be left; [c] cancels it
        return { phase: phase.back === 'releases' ? { kind: 'releases' } : { kind: 'menu' } };
      }
      if (phase.kind === 'confirm') return { phase: phase.back === 'releases' ? { kind: 'releases' } : { kind: 'menu' } };
      return { phase: { kind: 'menu' } };
  }
  return state;
}
