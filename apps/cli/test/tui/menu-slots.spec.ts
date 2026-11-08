/**
 * test/tui/menu-slots.spec.ts  (RETRO-F4, #582)
 *
 * The root menu's banner and footnote (src/tui/menu-slots.ts), drawn through the
 * platform menu slots (`createCli({ tuiMenuRoot })`): the 1.3 wordmark and tagline on a
 * wide terminal, a one-line title on a narrow one, and the "Update available" line once
 * the `update-info` state loader reports a newer release.
 */
import { resolveTuiMenuSlot } from '@marinoscar/platform-cli/tui';

import { APP_CLI_OPTIONS } from '../../src/app.js';
import {
  APP_TUI_MENU_ROOT,
  BANNER_ART,
  BANNER_MIN_COLUMNS,
  TAGLINE,
  rootBanner,
  rootFootnote,
} from '../../src/tui/menu-slots.js';
import { readVersion } from '../../src/version.js';

function context(columns: number, state: Record<string, unknown> = {}) {
  return { loggedIn: true, columns, sectionId: 'root', state };
}

describe('root menu banner', () => {
  it('draws the 1.3 wordmark and tagline when the terminal is wide enough', () => {
    expect(rootBanner({ columns: 100 })).toEqual([...BANNER_ART, `  ${TAGLINE}`]);
    expect(rootBanner({ columns: BANNER_MIN_COLUMNS })).toHaveLength(BANNER_ART.length + 1);
  });

  it('falls back to a one-line title on a narrow terminal instead of a cut-off drawing', () => {
    for (const columns of [BANNER_MIN_COLUMNS - 1, 40, 24]) {
      expect(rootBanner({ columns })).toEqual(['MemoriaHub']);
    }
  });

  it('never draws a line wider than its threshold', () => {
    for (const line of rootBanner({ columns: BANNER_MIN_COLUMNS })) {
      expect(line.length).toBeLessThanOrEqual(BANNER_MIN_COLUMNS - 4);
    }
  });
});

describe('root menu footnote', () => {
  it('is empty until the update check has settled, or when the CLI is current', () => {
    expect(rootFootnote({ state: {} })).toBeUndefined();
    expect(rootFootnote({ state: { 'update-info': { updateAvailable: false, latestVersion: '1.5.0' } } })).toBeUndefined();
  });

  it('names the newer release and the installed version when one is available', () => {
    const line = rootFootnote({ state: { 'update-info': { updateAvailable: true, latestVersion: '9.9.9' } } });
    expect(line).toBe(
      `⬆ Update available: 9.9.9 (you have ${readVersion()}) — run 'git pull' in the MemoriaHub repo and rebuild the CLI`,
    );
  });
});

describe('APP_TUI_MENU_ROOT', () => {
  it('is what createCli receives, with the footnote in the warning colour', () => {
    expect(APP_CLI_OPTIONS.tuiMenuRoot).toBe(APP_TUI_MENU_ROOT);
    expect(APP_TUI_MENU_ROOT.footnote?.color).toBe('warning');
  });

  it('resolves through the platform slot helper', () => {
    expect(resolveTuiMenuSlot(APP_TUI_MENU_ROOT.banner, context(24))).toEqual(['MemoriaHub']);
    expect(resolveTuiMenuSlot(APP_TUI_MENU_ROOT.footnote, context(100))).toEqual([]);
    const update = { 'update-info': { updateAvailable: true, latestVersion: '9.9.9' } };
    expect(resolveTuiMenuSlot(APP_TUI_MENU_ROOT.footnote, context(100, update))[0]).toContain('Update available: 9.9.9');
  });
});
