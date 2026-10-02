/**
 * test/tui/android-model.spec.ts — the Android screen's decisions (issue #517):
 * status rows, which actions are open, the confirmations, and every state
 * transition of the reducer (pure; no Ink).
 */

import type { AndroidRelease } from '../../src/android/publish.js';
import type { ReleaseStatus } from '../../src/android/release-status.js';
import type { BumpPart } from '../../src/android/version.js';
import {
  INITIAL_STATE,
  actionItems,
  defaultActionIndex,
  makeCurrentConfirmation,
  reduce,
  statusRows,
  type ActionItem,
  type ModelContext,
  type ScreenState,
} from '../../src/tui/android-model.js';

const current = (versionCode: number, overrides: Partial<AndroidRelease> = {}): AndroidRelease => ({
  id: `r${versionCode}`,
  packageName: 'memoriahub.marin.cr',
  versionName: `2.0.${versionCode - 100}`,
  versionCode,
  fileSha256: 'c'.repeat(64),
  sizeBytes: '2036135',
  isCurrent: true,
  createdAt: '2026-10-01T10:00:00.000Z',
  ...overrides,
});

function status(overrides: Partial<ReleaseStatus> = {}): ReleaseStatus {
  return {
    repoRoot: '/repo',
    local: { versionName: '2.0.1', versionCode: 101 },
    packageName: 'memoriahub.marin.cr',
    keystore: { configured: true, sha256: 'AA:BB' },
    login: { state: 'logged_in', serverUrl: 'https://photos.example', canPublish: true, email: 'admin@x' },
    server: { current: current(100), reachable: true },
    newerLocally: true,
    ...overrides,
  };
}

const ctx = (s: ReleaseStatus | undefined = status()): ModelContext => ({
  status: s,
  repoRoot: s?.repoRoot,
  preview: (part: BumpPart) => ({
    before: { versionName: '2.0.1', versionCode: 101 },
    after: { versionName: part === 'patch' ? '2.0.2' : part === 'minor' ? '2.1.0' : '3.0.0', versionCode: 102 },
    created: false,
  }),
});

const item = (items: ActionItem[], action: ActionItem['action']): ActionItem => items.find((entry) => entry.action === action)!;

describe('status rows', () => {
  it('shows Checkout, Local version, Keystore, Login/server, Server release and Newer?', () => {
    expect(statusRows(status()).map((row) => row.label)).toEqual([
      'Checkout',
      'Local version',
      'Keystore',
      'Login/server',
      'Server release',
      'Newer?',
    ]);
    const rows = statusRows(status());
    expect(rows.find((row) => row.label === 'Keystore')?.value).toBe('AA:BB');
    expect(rows.find((row) => row.label === 'Newer?')).toMatchObject({ color: 'green' });
    expect(statusRows(status({ newerLocally: false })).find((row) => row.label === 'Newer?')).toMatchObject({ color: 'yellow' });
    expect(statusRows(status({ repoRoot: undefined, local: null }))[0]).toMatchObject({ color: 'red' });
  });
});

describe('actions', () => {
  it('highlights Release by default and enables everything on a ready machine', () => {
    const items = actionItems(status());
    expect(items.map((entry) => entry.action)).toEqual(['doctor', 'bump', 'build', 'publish', 'release', 'releases']);
    expect(items.every((entry) => entry.enabled)).toBe(true);
    expect(items[defaultActionIndex(items)]?.action).toBe('release');
  });

  it('explains why actions are unavailable, and offers Log in', () => {
    const loggedOut = actionItems(status({ login: { state: 'logged_out', canPublish: false } }));
    expect(item(loggedOut, 'publish')).toMatchObject({ enabled: false, reason: 'Not logged in. Choose "Log in".' });
    expect(item(loggedOut, 'build').enabled).toBe(true);
    expect(loggedOut.at(-1)?.action).toBe('login');

    const noKeystore = actionItems(status({ keystore: { configured: false } }));
    expect(item(noKeystore, 'release').reason).toContain('keystore init');
    const noCheckout = actionItems(status({ repoRoot: undefined, local: null }));
    expect(item(noCheckout, 'bump').enabled).toBe(false);
    expect(item(noCheckout, 'doctor').enabled).toBe(true);
    const viewer = actionItems(status({ login: { state: 'logged_in', canPublish: false, email: 'v@x', serverUrl: 's' } }));
    expect(item(viewer, 'releases').reason).toContain('lacks system_settings:write');
  });
});

describe('the reducer', () => {
  const select = (state: ScreenState, action: ActionItem['action'], s = status()) =>
    reduce(state, { type: 'select', item: item(actionItems(s), action) }, ctx(s));

  it('a disabled action only shows its reason', () => {
    const s = status({ keystore: { configured: false } });
    const next = select(INITIAL_STATE, 'build', s);
    expect(next.phase.kind).toBe('menu');
    expect(next.notice?.text).toContain('keystore init');
  });

  it('doctor: plan runs a dry run; fix asks first (No → back to the menu)', () => {
    const doctor = select(INITIAL_STATE, 'doctor');
    expect(doctor.phase.kind).toBe('doctor-mode');
    const plan = reduce(doctor, { type: 'doctor-mode', mode: 'plan' }, ctx());
    expect(plan.phase).toMatchObject({ kind: 'task', running: true, task: { args: ['--repo', '/repo', 'doctor', '--dry-run'] } });

    const fix = reduce(doctor, { type: 'doctor-mode', mode: 'fix' }, ctx());
    expect(fix.phase).toMatchObject({ kind: 'confirm', task: { args: ['--repo', '/repo', 'doctor', '--fix', '--yes'] } });
    expect(reduce(fix, { type: 'confirm', yes: false }, ctx()).phase.kind).toBe('menu');
    expect(reduce(fix, { type: 'confirm', yes: true }, ctx()).phase).toMatchObject({ kind: 'task', running: true });
  });

  it('build starts a task immediately; done → back to the menu', () => {
    const running = select(INITIAL_STATE, 'build');
    expect(running.phase).toMatchObject({ kind: 'task', running: true, task: { title: 'Build', args: ['--repo', '/repo', 'build'] } });
    expect(reduce(running, { type: 'back' }, ctx())).toBe(running); // cannot leave a running task
    const done = reduce(running, { type: 'task-done', exitCode: 0 }, ctx());
    expect(done.phase).toMatchObject({ kind: 'task', running: false, exitCode: 0 });
    expect(reduce(done, { type: 'back' }, ctx()).phase.kind).toBe('menu');
  });

  it('publish: notes → a confirmation naming the server → the publish task', () => {
    const notes = select(INITIAL_STATE, 'publish');
    expect(notes.phase).toEqual({ kind: 'notes', for: 'publish' });
    const confirm = reduce(notes, { type: 'notes', text: '  Faster sync ' }, ctx());
    expect(confirm.phase.kind).toBe('confirm');
    if (confirm.phase.kind !== 'confirm') throw new Error('unreachable');
    expect(confirm.phase.confirmation.question).toBe('Publish v2.0.1 (101) to https://photos.example?');
    expect(confirm.phase.task.args).toEqual(['--repo', '/repo', 'publish', '--notes', 'Faster sync']);
  });

  it('publish warns when the local version is not newer than the server', () => {
    const s = status({ server: { current: current(105), reachable: true }, newerLocally: false });
    const confirm = reduce(select(INITIAL_STATE, 'publish', s), { type: 'notes', text: '' }, ctx(s));
    if (confirm.phase.kind !== 'confirm') throw new Error('unreachable');
    expect(confirm.phase.confirmation.warning).toContain('not newer');
  });

  it('release: part → notes → confirmation listing the steps → the release task', () => {
    const part = select(INITIAL_STATE, 'release');
    expect(part.phase).toEqual({ kind: 'part', for: 'release' });
    const notes = reduce(part, { type: 'part', part: 'minor' }, ctx());
    expect(notes.phase).toEqual({ kind: 'notes', for: 'release', part: 'minor' });
    const confirm = reduce(notes, { type: 'notes', text: 'first' }, ctx());
    if (confirm.phase.kind !== 'confirm') throw new Error('unreachable');
    expect(confirm.phase.confirmation.question).toBe('Release v2.1.0 (102) to https://photos.example?');
    expect(confirm.phase.confirmation.lines.join('\n')).toContain('Bump version.properties 2.0.1 (101) → 2.1.0 (102)');
    expect(confirm.phase.task.args).toEqual(['--repo', '/repo', 'release', '--bump', 'minor', '--notes', 'first']);

    const noBump = reduce(reduce(part, { type: 'part', part: undefined }, ctx()), { type: 'notes', text: '' }, ctx());
    if (noBump.phase.kind !== 'confirm') throw new Error('unreachable');
    expect(noBump.phase.task.args).toEqual(['--repo', '/repo', 'release']);
  });

  it('bump: choosing a part returns to the menu (the screen writes the file)', () => {
    const part = select(INITIAL_STATE, 'bump');
    expect(part.phase).toEqual({ kind: 'part', for: 'bump' });
    expect(reduce(part, { type: 'part', part: 'patch' }, ctx()).phase.kind).toBe('menu');
  });

  it('releases: make current confirms (rollback warns) and returns to the list', () => {
    const list = select(INITIAL_STATE, 'releases');
    expect(list.phase.kind).toBe('releases');
    const releases = [current(101), current(100, { isCurrent: false })];

    const already = reduce(list, { type: 'make-current', target: releases[0]!, releases }, ctx());
    expect(already.phase.kind).toBe('releases');
    expect(already.notice?.text).toContain('already the current release');

    const confirm = reduce(list, { type: 'make-current', target: releases[1]!, releases }, ctx());
    if (confirm.phase.kind !== 'confirm') throw new Error('unreachable');
    expect(confirm.phase.confirmation.warning).toContain('ROLLS BACK');
    expect(confirm.phase.confirmation.yes).toBe('Yes, roll back');
    expect(confirm.phase.task.args).toEqual(['releases', 'current', 'r100', '--yes']);
    expect(reduce(confirm, { type: 'confirm', yes: false }, ctx()).phase.kind).toBe('releases');
    const task = reduce(confirm, { type: 'confirm', yes: true }, ctx());
    const done = reduce(task, { type: 'task-done', exitCode: 0 }, ctx());
    expect(reduce(done, { type: 'back' }, ctx()).phase.kind).toBe('releases');
  });

  it('a forward make-current has no warning', () => {
    const confirmation = makeCurrentConfirmation(current(102, { isCurrent: false }), [current(101)], 'https://s');
    expect(confirmation.warning).toBeUndefined();
    expect(confirmation.yes).toBe('Yes, make it current');
  });

  it('events that do not fit the phase are ignored', () => {
    expect(reduce(INITIAL_STATE, { type: 'confirm', yes: true }, ctx())).toBe(INITIAL_STATE);
    expect(reduce(INITIAL_STATE, { type: 'task-done', exitCode: 1 }, ctx())).toBe(INITIAL_STATE);
    expect(reduce(INITIAL_STATE, { type: 'notes', text: 'x' }, ctx())).toBe(INITIAL_STATE);
  });
});
