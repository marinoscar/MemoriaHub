import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { createCli } from '@marinoscar/platform-cli';

import { runApp } from '../src/run.js';

let state: string;
let err: string;
let env: NodeJS.ProcessEnv;
let handed: string[][];
const stderr = { write: (t: string) => void (err += t) };

function fakeCli(exit = 0, during?: () => void): typeof createCli {
  return (() => ({
    program: {} as never,
    run: async (argv: string[]) => {
      handed.push(argv);
      during?.();
      return exit;
    },
  })) as unknown as typeof createCli;
}

beforeEach(() => {
  state = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-run-'));
  env = { MEMORIAHUB_STATE_DIR: state };
  process.env['MEMORIAHUB_STATE_DIR'] = state;
  err = '';
  handed = [];
});
afterEach(() => {
  delete process.env['MEMORIAHUB_STATE_DIR'];
  fs.rmSync(state, { recursive: true, force: true });
});

describe('runApp', () => {
  it('hands ordinary arguments to the platform CLI and returns its exit code', async () => {
    expect(await runApp(['circles', 'list'], { stderr, env, createCli: fakeCli(3) })).toBe(3);
    expect(handed).toEqual([['circles', 'list']]);
  });

  it('translates --no-color / -V before the platform parses them', async () => {
    await runApp(['--no-color', '-V'], { stderr, env, createCli: fakeCli() });
    expect(handed).toEqual([['--version']]);
    expect(env['NO_COLOR']).toBe('1');
  });

  it('mirrors MEMORIAHUB_URL onto MEMORIAHUB_SERVER_URL', async () => {
    env['MEMORIAHUB_URL'] = 'https://w.example.test';
    await runApp(['status'], { stderr, env, createCli: fakeCli() });
    expect(env['MEMORIAHUB_SERVER_URL']).toBe('https://w.example.test');
  });

  it('migrates a 1.3.4 config so the user stays logged in', async () => {
    fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ serverUrl: 'https://a.example.test', pat: 'pat_x', activeCircleId: 'c' }));
    await runApp(['status'], { stderr, env, createCli: fakeCli() });
    const cfg = JSON.parse(fs.readFileSync(path.join(state, 'config.json'), 'utf8'));
    expect(cfg).toMatchObject({ token: 'pat_x', activeCircleId: 'c' });
    expect(cfg.pat).toBeUndefined();
  });

  it('routes the node group to the 1.3 implementation, never to the platform', async () => {
    const legacy: string[][] = [];
    const code = await runApp(['node', 'start', '--headless'], {
      stderr, env, createCli: fakeCli(),
      runLegacyNode: async (argv) => { legacy.push(argv); return 0; },
    });
    expect(code).toBe(0);
    expect(legacy).toEqual([['node', 'start', '--headless']]);
    expect(handed).toEqual([]);
  });

  it('prints notes on stderr and applies deploy defaults', async () => {
    await runApp(['deploy', 'install'], { stderr, env, createCli: fakeCli() });
    expect(err).toContain('legacy default domain');
    expect(handed[0]).toEqual(expect.arrayContaining(['--port', '8328']));
  });

  it('keeps app-only config fields across the platform login', async () => {
    const file = path.join(state, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ serverUrl: 'https://a.example.test', token: 'pat_old', activeCircleId: 'c1' }));
    // The platform resolves ~/.memoriahub from HOME and ignores MEMORIAHUB_STATE_DIR.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-home-'));
    env['HOME'] = home;
    const platformFile = path.join(home, '.memoriahub', 'config.json');
    const cli = fakeCli(0, () => {
      fs.mkdirSync(path.dirname(platformFile), { recursive: true });
      fs.writeFileSync(platformFile, JSON.stringify({ serverUrl: 'https://b.example.test', token: 'pat_new' }));
    });
    try {
      await runApp(['login', '--token', 'pat_new'], { stderr, env, createCli: cli });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      serverUrl: 'https://b.example.test', token: 'pat_new', activeCircleId: 'c1',
    });
  });

  it('opens the platform TUI for a lone `menu` (the 1.3 spelling of a bare invocation)', async () => {
    await runApp(['menu'], { stderr, env, createCli: fakeCli() });
    expect(handed).toEqual([[]]);
  });

  it('a broken composition is one stderr line and a non-zero exit', async () => {
    const boom = (() => { throw new Error('duplicate command'); }) as unknown as typeof createCli;
    const code = await runApp(['status'], { stderr, env, createCli: boom });
    expect(code).not.toBe(0);
    expect(err).toContain('duplicate command');
  });
});
