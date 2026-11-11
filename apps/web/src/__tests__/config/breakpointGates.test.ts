import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

/**
 * The five coupled breakpoint gates are the PACKAGE's since RETRO-F1 (#571):
 *
 *   1. `ShellLayout` `showRail`            `up('sm')`
 *   2. `ShellBottomNav` self-gate          `down('sm')`
 *   3. `<main>` `pb: { xs: 10, sm: 3 }`    (in `ShellLayout`)
 *   4. `SettingsHub` `isCompactWindow`     `down('sm')`
 *   5. `ShellAppBar` `isCompactWindow`     `down('sm')`
 *
 * all under `@marinoscar/platform-web` (`shell/ui`, `settings/ui`), which this
 * repository does not edit. What it CAN do is refuse to grow a sixth read in
 * the chrome it binds. This suite scans `apps/web/src` for the two ways a
 * component reads a breakpoint, `useMediaQuery(` and
 * `theme.breakpoints.up|down|between|only(`, and fails on any file that is not
 * listed below with a reason. Adding a read is allowed; adding it WITHOUT
 * writing down why it is not a gate is not. (A text scan, not a parser: block
 * and line comments are stripped first so prose that names them does not
 * count. Responsive `sx` objects are CSS, not reads, and are not scanned.)
 *
 * The boundary is `sm` (600px), never `md` (CLAUDE.md, issue #402).
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../..');
// RETRO-J11 (#626): the packaged domain slices are scanned too, so moving a page out of the app
// never moves a breakpoint read out of sight. Their files are keyed `memoriahub-web/<path>`.
const WEB_PACKAGE_SRC = join(dirname(fileURLToPath(import.meta.url)), '../../../../../packages/memoriahub-web/src');

const BREAKPOINT_READ = /\buseMediaQuery\s*\(|\bbreakpoints\.(?:up|down|between|only)\s*\(/;

/** Why a file may read a breakpoint without being one of the five gates. */
const WHY = {
  appBarControls:
    'the AppBar binding chooses which CONTROLS its slots carry (the search pill and the labelled Upload button at sm and up, where Search has no bottom-bar tab); the packaged ShellAppBar owns the drill-down gate',
  searchPill:
    'the search pill picks its own collapsed-icon or inline form; it mounts no navigation',
  contextPane:
    'mirrors the packaged rail\'s lg expanded tier so a hub page knows whether the context pane replaces it; it mounts no chrome',
  dialog: 'a dialog, drawer or sheet goes full-screen or compact below a width; page content, not navigation chrome',
  media: 'a media surface (gallery grid, viewer, player, carousel) sizes its own content; page content, not navigation chrome',
  panel: 'a page-local panel or section chooses its own compact layout; page content, not navigation chrome',
} as const;

const ALLOWED_READS: Readonly<Record<string, string>> = {
  'components/navigation/AppBar.tsx': WHY.appBarControls,
  'components/search/TopbarSearch.tsx': WHY.searchPill,
  'hooks/useContextPaneVisible.ts': WHY.contextPane,

  'components/media/MediaDetailDrawer.tsx': WHY.dialog,
  'components/search/SearchPanel.tsx': WHY.dialog,

  'memoriahub-web/media/ui/components/MediaGallery.tsx': WHY.media,
  'components/media/MediaLightbox.tsx': WHY.media,
  'components/media/VideoPlayer.tsx': WHY.media,
  'memoriahub-web/memories/ui/components/MemoriesCarousel.tsx': WHY.media,
  'memoriahub-web/memories/ui/components/MemoryCard.tsx': WHY.media,
  'memoriahub-web/memories/ui/components/MemoryStoryPlayer.tsx': WHY.media,

  'components/review/MemberComparison.tsx': WHY.panel,
  'components/settings/mediaSync/DiagnosticsSection.tsx': WHY.panel,
  'components/settings/mediaSync/SyncHistory.tsx': WHY.panel,
  'components/workflows/builder/WorkflowPreviewPanel.tsx': WHY.panel,
};

/** The app's shell chrome and its bindings: they read no breakpoint at all. */
const CHROME = [
  'App.tsx',
  'main.tsx',
  'components/common/Layout.tsx',
  'components/navigation/NavigationRail.tsx',
  'components/navigation/BottomNav.tsx',
  'components/navigation/NavContextPane.tsx',
  'components/navigation/UserMenu.tsx',
  'components/navigation/OwnerScopeChip.tsx',
  'config/shell.ts',
  'config/destinations.ts',
  'config/adminSections.tsx',
  'config/userSettingsSections.tsx',
  'contexts/ThemeContext.tsx',
  'pages/UserSettingsHubPage.tsx',
  'pages/Admin/SettingsHubPage.tsx',
  'pages/Collections/CollectionsHubPage.tsx',
  'pages/Reviews/ReviewHubPage.tsx',
  'platform/platformHost.tsx',
  'platform/shellProviders.tsx',
  'theme/index.ts',
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function isTestFile(path: string): boolean {
  const parts = path.split(sep);
  return parts.includes('__tests__') || /\.(test|spec)\.(ts|tsx)$/.test(path) || parts.includes('mocks');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !isTestFile(full) ? [full] : [];
  });
}

const FILES = sourceFiles(SRC);
const PACKAGE_FILES = sourceFiles(WEB_PACKAGE_SRC);
const reads = (file: string) => BREAKPOINT_READ.test(stripComments(readFileSync(file, 'utf8')));
const READERS = [
  ...FILES.filter(reads).map((file) => relative(SRC, file).split(sep).join('/')),
  ...PACKAGE_FILES.filter(reads).map((file) => `memoriahub-web/${relative(WEB_PACKAGE_SRC, file).split(sep).join('/')}`),
];

describe("breakpoint gates — the five are the package's (RETRO-F1, #571)", () => {
  it('scans the source tree (guards the scan itself against matching nothing)', () => {
    expect(FILES.length).toBeGreaterThan(100);
    expect(PACKAGE_FILES.length).toBeGreaterThan(20);
    expect(READERS).toContain('components/navigation/AppBar.tsx');
  });

  it('every file that reads a breakpoint is listed with a reason', () => {
    const unlisted = READERS.filter((file) => !(file in ALLOWED_READS));
    expect(
      unlisted,
      'These files read a breakpoint and are not listed in ALLOWED_READS. The five coupled gates live ' +
        'in @marinoscar/platform-web; a new read must say why it is not a sixth gate.',
    ).toEqual([]);
  });

  it('lists no file that has stopped reading a breakpoint (the allowlist stays honest)', () => {
    expect(Object.keys(ALLOWED_READS).filter((file) => !READERS.includes(file))).toEqual([]);
  });

  it('gives every listed read a reason', () => {
    for (const [file, reason] of Object.entries(ALLOWED_READS)) {
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(20);
    }
  });

  describe('shell chrome and its bindings read no breakpoint', () => {
    it.each(CHROME)('%s', (file) => {
      expect(existsSync(join(SRC, file)), `${file} must exist`).toBe(true);
      expect(READERS).not.toContain(file);
      expect(Object.keys(ALLOWED_READS)).not.toContain(file);
    });
  });

  it('keeps the deleted app-side copies deleted', () => {
    for (const gone of ['components/datatable', 'hooks/useNavigationPrefs.ts', 'theme/components.ts']) {
      expect(existsSync(join(SRC, gone)), `${gone} must stay deleted`).toBe(false);
    }
  });

  it('keeps the remaining app-side navigation files thin bindings of the package', () => {
    for (const file of [
      'components/common/Layout.tsx',
      'components/navigation/AppBar.tsx',
      'components/navigation/NavigationRail.tsx',
      'components/navigation/BottomNav.tsx',
    ]) {
      expect(readFileSync(join(SRC, file), 'utf8')).toMatch(/@marinoscar\/platform-web\/shell\/ui/);
    }
  });
});
