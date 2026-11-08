import { createCli } from '@marinoscar/platform-cli';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { listRegisteredProxyStreamPaths, planDeploySteps } from '@marinoscar/platform-cli/deploy';

import { APP_CLI_OPTIONS, APP_COMMAND_FACTORIES, APP_STREAM_PATHS, APP_UPDATE_NOTICE, APP_VERSIONED_MANIFESTS, readVersion } from '../src/app.js';

// Every command of the 1.3 inventory (issue #577) except the two that are
// platform built-ins now (`login`) or routed to the 1.3 implementation (`node`).
const INVENTORY = [
  'import', 'sync', 'scan', 'organize', 'screenshots', 'convert', 'date-infer', 'status', 'folders',
  'circles', 'retry', 'settings', 'backup', 'jobs', 'reports', 'workflow', 'android', 'menu',
];

const SUBCOMMANDS: Record<string, string[]> = {
  scan: ['list', 'report', 'export'],
  'date-infer': ['diagnose', 'apply'],
  folders: ['add', 'list', 'remove', 'enable', 'disable'],
  circles: ['list', 'use'],
  settings: ['list', 'get', 'set', 'reset'],
  backup: ['init', 'run', 'status', 'schedule', 'set-rate', 'verify', 'prune', 'restore'],
  reports: ['list', 'show'],
  workflow: ['list', 'run', 'runs'],
  android: ['doctor', 'keystore', 'version', 'build', 'publish', 'releases', 'release'],
};

describe('APP_CLI_OPTIONS', () => {
  beforeEach(() => resetCliForTests());

  it('composes without a registry conflict', () => {
    expect(() => createCli(APP_CLI_OPTIONS)).not.toThrow();
  });

  it('registers every inventory command exactly once, next to the platform built-ins', () => {
    const { program } = createCli(APP_CLI_OPTIONS);
    const names = program.commands.map((c) => c.name());
    for (const name of [...INVENTORY, 'login', 'init', 'api', 'config', 'deploy']) {
      expect(names.filter((n) => n === name)).toHaveLength(1);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('keeps the subcommands of each command', () => {
    const { program } = createCli(APP_CLI_OPTIONS);
    for (const [name, subs] of Object.entries(SUBCOMMANDS)) {
      const cmd = program.commands.find((c) => c.name() === name)!;
      const have = cmd.commands.map((c) => c.name());
      for (const sub of subs) expect(have).toContain(sub);
    }
  });

  it('keeps the jobs|queue alias', () => {
    const { program } = createCli(APP_CLI_OPTIONS);
    expect(program.commands.find((c) => c.name() === 'jobs')!.aliases()).toContain('queue');
  });

  it('has one factory per inventory command', () => {
    expect(APP_COMMAND_FACTORIES.map((f) => f().name())).toEqual(INVENTORY.filter((n) => n !== 'node'));
  });

  it('adds the MemoriaHub deploy steps in the right place', () => {
    createCli(APP_CLI_OPTIONS);
    for (const pipeline of ['install', 'update'] as const) {
      const ids = planDeploySteps(pipeline).map((s) => s.id);
      expect(ids.indexOf('database-extensions')).toBe(ids.indexOf('migrate') - 1);
    }
    const install = planDeploySteps('install').map((s) => s.id);
    const update = planDeploySteps('update').map((s) => s.id);
    expect(install.indexOf('compreface-healthy')).toBe(install.indexOf('start') + 1);
    expect(update.indexOf('compreface-healthy')).toBe(update.indexOf('restart') + 1);
  });

  it('registers the app stream path and not the CLI in the versioned manifests', () => {
    createCli(APP_CLI_OPTIONS);
    expect(APP_STREAM_PATHS.every((p) => !p.endsWith('/'))).toBe(true);
    expect(listRegisteredProxyStreamPaths().map((p) => p.path)).toEqual(expect.arrayContaining([...APP_STREAM_PATHS]));
    expect(APP_VERSIONED_MANIFESTS).not.toContain('apps/cli/package.json');
  });

  it('reads the package version', () => {
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(APP_CLI_OPTIONS.version).toBe(readVersion());
  });
});

// The 1.3 update notice (update-notice.ts) is replaced by the platform's
// `updateNotice`: its throttle (24 h), silence for --help/--version, CI and
// non-TTY are the platform's behaviour (covered in @marinoscar/platform-cli).
// What stays ours is where the newest version is read from.
describe('APP_UPDATE_NOTICE', () => {
  it('points at the installer and reads apps/cli/package.json on main', async () => {
    expect(APP_UPDATE_NOTICE.upgradeHint).toContain('marinoscar/MemoriaHub/main/install.sh');
    expect(typeof APP_UPDATE_NOTICE.latestVersion).toBe('function');
  });

  it('is silent when the network check fails', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    try {
      await expect(APP_UPDATE_NOTICE.latestVersion()).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = real;
    }
  });
});
