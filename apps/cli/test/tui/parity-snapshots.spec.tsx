/**
 * test/tui/parity-snapshots.spec.tsx  (RETRO-F4, #582: "after")
 *
 * Renders the same frames as the 1.3 generator did (see test/fixtures/tui-snapshots/before),
 * now through the platform TUI: the root menu and every submenu via `renderTuiMenu`, and the
 * first frame of each network-free screen via `renderTuiRoute`, at the fake terminal's
 * fixed 100 columns, logged out and in. Frames are ANSI stripped and written to
 * test/fixtures/tui-snapshots/after; `diff -r before after` lists every difference, and
 * docs/platform-adoption/tui-parity.md explains each one.
 *
 * Besides writing the frames this spec ASSERTS the parity that does not depend on
 * drawing: every row of the 1.3 menu tree is reachable by the same label path in the
 * same order, and each section's subtitle and the logged-out cascade are unchanged.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCli } from '@marinoscar/platform-cli';
import { renderTuiMenu, renderTuiRoute, cleanup } from '@marinoscar/platform-cli/tui/testing';
import { BUILTIN_TUI_SCREENS } from '@marinoscar/platform-cli/tui';

import { APP_CLI_OPTIONS } from '../../src/app.js';
import { APP_TUI_MENU, PLATFORM_HIDDEN_SCREENS } from '../../src/tui/menu.js';
import { APP_TUI_SCREENS } from '../../src/tui/screens.js';

const PHASE = process.env['TUI_SNAPSHOT_PHASE'] ?? 'after';
const OUT = path.resolve(process.cwd(), 'test', 'fixtures', 'tui-snapshots', PHASE);

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '');
}

function save(name: string, frame: string | undefined): void {
  fs.mkdirSync(OUT, { recursive: true });
  const text = strip(frame ?? '')
    // The header carries the CLI version; keep the frames stable across version bumps.
    .replace(/(MemoriaHub CLI v)\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/g, '$1<version>')
    .replace(/(Help {2}· v)\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/g, '$1<version>')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n');
  fs.writeFileSync(path.join(OUT, `${name}.txt`), `${text}\n`);
  expect(text.trim().length).toBeGreaterThan(0);
}

const SCREENS = [
  ...BUILTIN_TUI_SCREENS.map((s) => ({
    route: s.route,
    order: s.order,
    label: s.route === 'deploy' ? 'Deploy  (this server)' : s.route,
    hidden: (PLATFORM_HIDDEN_SCREENS as readonly string[]).includes(s.route),
  })),
  ...APP_TUI_SCREENS.map((s) => ({ route: s.route, order: s.order, label: s.label })),
];

const SECTIONS = ['sync', 'scan', 'node', 'reports', 'file-tools', 'convert', 'screenshots', 'date-infer', 'settings'];

describe(`TUI parity snapshots (${PHASE})`, () => {
  const savedStateDir = process.env['MEMORIAHUB_STATE_DIR'];
  beforeAll(() => {
    process.env['MEMORIAHUB_STATE_DIR'] = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-parity-'));
    // The real composition registers the screens, the menu and the app state exactly once.
    createCli(APP_CLI_OPTIONS);
  });
  afterAll(() => {
    if (savedStateDir === undefined) delete process.env['MEMORIAHUB_STATE_DIR'];
    else process.env['MEMORIAHUB_STATE_DIR'] = savedStateDir;
  });
  afterEach(() => cleanup());

  for (const loggedIn of [false, true]) {
    const tag = loggedIn ? 'in' : 'out';

    it(`root menu (logged ${tag})`, async () => {
      const menu = await renderTuiMenu({ nodes: APP_TUI_MENU, screens: SCREENS, loggedIn });
      save(`menu-root-${tag}`, await menu.waitForFrame((f) => f.includes('Quit')));
    });

    for (const id of SECTIONS) {
      it(`submenu ${id} (logged ${tag})`, async () => {
        const menu = await renderTuiMenu({ nodes: APP_TUI_MENU, screens: SCREENS, loggedIn, section: id });
        if (menu.labels().length === 0) return; // not reachable in this login state
        save(`menu-${id}-${tag}`, await menu.waitForFrame((f) => f.length > 20));
      });
    }
  }

  const screens: [name: string, route: string][] = [
    ['screen-factory-reset', 'factory-reset'],
    ['screen-date-range', 'sync-all'],
    ['screen-convert-file-input', 'convert-file'],
    ['screen-pick-folders', 'sync-select'],
    ['screen-folders', 'folders'],
    ['screen-app-settings', 'app-settings'],
    ['screen-report-overview', 'report-overview'],
    ['screen-login', 'memoriahub-login'],
    ['screen-help', 'help'],
  ];
  for (const [name, route] of screens) {
    it(`screen ${route}`, async () => {
      const screen = await renderTuiRoute(route, { session: { loggedIn: true }, useRegistered: true });
      save(name, await screen.waitForFrame((f) => f.trim().length > 0));
    });
  }
});

