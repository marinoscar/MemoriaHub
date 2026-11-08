/**
 * test/tui/parity-snapshots.spec.tsx  (RETRO-F4, #582, step 1: "before")
 *
 * Pins what the 1.3 TUI drew, so the re-host onto the platform TUI framework can
 * prove parity. It renders, at the fake terminal's fixed 100 columns, logged out
 * and logged in: the root menu, every submenu (with its breadcrumb and subtitle)
 * and the first frame of each screen that needs no network. Frames are ANSI
 * stripped and written to test/fixtures/tui-snapshots/<phase>/<name>.txt; the
 * phase is TUI_SNAPSHOT_PHASE (this file is the "before" generator).
 */
import React from 'react';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { render, cleanup } from 'ink-testing-library';

import { openDb } from '../../src/db/database.js';
import { HomeMenu } from '../../src/tui/HomeMenu.js';
import { Menu } from '../../src/tui/Menu.js';
import { MENU_TREE, breadcrumb, findSubmenu, menuItemLabel, visibleChildren, type MenuSubmenu } from '../../src/tui/menu-config.js';
import { FactoryResetScreen } from '../../src/tui/FactoryResetScreen.js';
import { DateRangeFilter } from '../../src/tui/DateRangeFilter.js';
import { ConvertFileInput } from '../../src/tui/ConvertFileInput.js';
import { PickFolders } from '../../src/tui/PickFolders.js';
import { FolderManager } from '../../src/tui/FolderManager.js';
import { SettingsScreen } from '../../src/tui/SettingsScreen.js';
import { ReportView } from '../../src/tui/ReportView.js';
import { LoginScreen } from '../../src/tui/LoginScreen.js';
import { waitForFrame } from './wait-for.js';

const PHASE = process.env['TUI_SNAPSHOT_PHASE'] ?? 'before';
const OUT = path.resolve(process.cwd(), 'test', 'fixtures', 'tui-snapshots', PHASE);
const FAKE_CONFIG = { serverUrl: 'http://server.example.test', pat: 'tok-test' };

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '');
}

function save(name: string, frame: string | undefined): void {
  fs.mkdirSync(OUT, { recursive: true });
  const text = strip(frame ?? '')
    .replace(/DB:\s+\S+memoriahub\.db/g, 'DB: <db path>')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n');
  fs.writeFileSync(path.join(OUT, `${name}.txt`), `${text}\n`);
  expect(text.trim().length).toBeGreaterThan(0);
}

const noop = (): void => {};

describe(`TUI parity snapshots (${PHASE})`, () => {
  const savedStateDir = process.env['MEMORIAHUB_STATE_DIR'];
  beforeAll(() => {
    process.env['MEMORIAHUB_STATE_DIR'] = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-parity-'));
  });
  afterAll(() => {
    if (savedStateDir === undefined) delete process.env['MEMORIAHUB_STATE_DIR'];
    else process.env['MEMORIAHUB_STATE_DIR'] = savedStateDir;
  });
  afterEach(() => cleanup());

  for (const loggedIn of [false, true]) {
    const tag = loggedIn ? 'in' : 'out';

    it(`root menu (logged ${tag})`, () => {
      const { lastFrame } = render(
        <HomeMenu
          config={loggedIn ? FAKE_CONFIG : null}
          identity={loggedIn ? 'user@example.test' : null}
          activeCircleName={loggedIn ? 'Circle Alpha' : null}
          onSelect={noop}
          currentVersion="1.4.0"
          folderCount={1}
        />,
      );
      save(`menu-root-${tag}`, lastFrame());
    });

    const ids: string[] = [];
    (function walk(node: MenuSubmenu): void {
      for (const child of node.children) {
        if (child.kind === 'submenu') {
          ids.push(child.id);
          walk(child);
        }
      }
    })(MENU_TREE);

    for (const id of ids) {
      it(`submenu ${id} (logged ${tag})`, () => {
        const submenu = findSubmenu(id)!;
        const items = visibleChildren(submenu, loggedIn).map((node, i) => ({
          label: menuItemLabel(node, i + 1),
          value: String(i),
          ...(node.color ? { color: node.color } : {}),
        }));
        if (items.length === 0) return; // not reachable in this login state
        const { lastFrame } = render(
          <Menu title={breadcrumb(id)} subtitle={submenu.subtitle} items={items} onSelect={noop} onBack={noop} />,
        );
        save(`menu-${id}-${tag}`, lastFrame());
      });
    }
  }

  it('factory reset', () => {
    save('screen-factory-reset', render(<FactoryResetScreen onConfirm={noop} onCancel={noop} />).lastFrame());
  });
  it('date range filter', () => {
    save('screen-date-range', render(<DateRangeFilter onApply={noop} onBack={noop} />).lastFrame());
  });
  it('convert file input', () => {
    save('screen-convert-file-input', render(<ConvertFileInput onConfirm={noop} onBack={noop} />).lastFrame());
  });
  it('pick folders', () => {
    const db = openDb(':memory:');
    save('screen-pick-folders', render(<PickFolders db={db} onConfirm={noop} onBack={noop} />).lastFrame());
    db.close();
  });
  it('folder manager', () => {
    const db = openDb(':memory:');
    save('screen-folders', render(<FolderManager db={db} onBack={noop} />).lastFrame());
    db.close();
  });
  it('app settings', () => {
    const db = openDb(':memory:');
    save('screen-app-settings', render(<SettingsScreen db={db} onBack={noop} />).lastFrame());
    db.close();
  });
  it('report view (overview)', async () => {
    const db = openDb(':memory:');
    const { lastFrame } = render(<ReportView db={db} reportId="overview" onBack={noop} />);
    await waitForFrame(lastFrame, (f) => f.length > 0);
    save('screen-report-overview', lastFrame());
    db.close();
  });
  it('login (server step)', () => {
    save('screen-login', render(<LoginScreen initialConfig={null} onDone={noop} onBack={noop} />).lastFrame());
  });
});
