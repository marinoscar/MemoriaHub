/**
 * test/tui/scan-screen.spec.tsx
 *
 * Tests for ScanScreen (the app-hosted scan screen used by the interactive
 * menu), covering both operating modes:
 *
 *   - mode="view": loads the latest completed scan from the DB on mount.
 *   - mode="run":  subscribes to an injected `_engineForTesting` ScanEngine and
 *                  renders live progress, then the final report (or an error).
 *
 * We inject the engine via the `_engineForTesting` prop added for testability,
 * mirroring the pattern used in sync-dashboard.spec.tsx. The prop is optional
 * and minimal — the normal code path (constructing a real ScanEngine and
 * calling .run()) is unchanged.
 *
 * Note on async rendering: Ink re-renders asynchronously in response to
 * setState calls (including the state set inside ScanScreen's mount-time
 * useEffect for mode="view"). After emitting events — or after the initial
 * render when an effect is expected to run — we wait a tick with a short
 * setTimeout so React can flush state updates before asserting.
 */

import React from 'react';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { render, cleanup } from 'ink-testing-library';
import { ScanScreen } from '../../src/tui/ScanScreen.js';
import { ScanEngine } from '../../src/scan/scan-engine.js';
import { SCAN_EV } from '../../src/scan/events.js';
import { ScanRepo, type ScanTotals } from '../../src/repo/scans.js';
import { FolderRepo } from '../../src/repo/folders.js';
import { SettingsRepo } from '../../src/repo/settings.js';
import { openDb } from '../../src/db/database.js';
import { exportsDir } from '../../src/paths.js';
import type BetterSqlite3 from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Strip ANSI escape codes for readable assertions.
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

/** Wait a tick for React/Ink to flush state updates. */
function flushAsync(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeDb(): BetterSqlite3.Database {
  return openDb(':memory:');
}

let folderCounter = 0;

/**
 * Seed a fully-finished scan (folder + a few scan_files rows + rollup totals)
 * and return its scanId. Uses a unique folder path per call so repeated
 * seeding within a test file never collides with FolderRepo's duplicate-path
 * guard.
 */
function seedCompletedScan(db: BetterSqlite3.Database): number {
  const scans = new ScanRepo(db);
  const folders = new FolderRepo(db);

  folderCounter += 1;
  const folder = folders.add({ path: `/tmp/scan-test-folder-${folderCounter}` });

  const scanId = scans.startScan({ trigger: 'menu', folderIds: [folder.id] });

  scans.insertScanFile(scanId, {
    folderId: folder.id,
    filePath: `${folder.path}/IMG_0001.jpg`,
    sizeBytes: 1_500_000,
    mtimeMs: Date.now(),
    mimeType: 'image/jpeg',
    mediaKind: 'photo',
    hasExif: true,
    hasGps: true,
    capturedAt: new Date().toISOString(),
    width: 4032,
    height: 3024,
    cameraMake: 'Apple',
    cameraModel: 'iPhone 14 Pro',
    takenLat: 9.9281,
    takenLng: -84.0907,
  });

  scans.insertScanFile(scanId, {
    folderId: folder.id,
    filePath: `${folder.path}/IMG_0002.jpg`,
    sizeBytes: 2_100_000,
    mtimeMs: Date.now(),
    mimeType: 'image/jpeg',
    mediaKind: 'photo',
    hasExif: false,
    hasGps: false,
  });

  scans.insertScanFile(scanId, {
    folderId: folder.id,
    filePath: `${folder.path}/clip.mov`,
    sizeBytes: 10_000_000,
    mtimeMs: Date.now(),
    mimeType: 'video/quicktime',
    mediaKind: 'video',
    hasExif: false,
    hasGps: false,
  });

  const totals: ScanTotals = scans.computeTotals(scanId);
  scans.finishScan(scanId, totals);

  return scanId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScanScreen', () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    cleanup();
    db.close();
  });

  // -------------------------------------------------------------------------
  // mode="view", no scans in the DB
  // -------------------------------------------------------------------------

  it('shows "No scans yet" in view mode when the DB has no completed scans', async () => {
    const { lastFrame } = render(
      <ScanScreen db={db} mode="view" onHome={() => {}} onBack={() => {}} />,
    );

    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('No scans yet');
  });

  // -------------------------------------------------------------------------
  // mode="view", with a seeded completed scan
  // -------------------------------------------------------------------------

  it('renders the report for the latest completed scan in view mode', async () => {
    const scanId = seedCompletedScan(db);
    void scanId;

    const { lastFrame } = render(
      <ScanScreen db={db} mode="view" onHome={() => {}} onBack={() => {}} />,
    );

    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Scan Report');
    // 3 files were seeded (2 photos + 1 video).
    expect(plain).toContain('3');
    expect(plain).toContain('EXIF present');
    expect(plain).toContain('[q/Esc] back');
  });

  // -------------------------------------------------------------------------
  // mode="run" with an injected engine — progress then done
  // -------------------------------------------------------------------------

  it('shows live progress then the report when SCAN_PROGRESS/SCAN_DONE are emitted (run mode)', async () => {
    const scanId = seedCompletedScan(db);

    const scans = new ScanRepo(db);
    const folders = new FolderRepo(db);
    const settings = new SettingsRepo(db);
    const engine = new ScanEngine({ scans, folders, settings });

    const { lastFrame } = render(
      <ScanScreen
        db={db}
        mode="run"
        onHome={() => {}}
        onBack={() => {}}
        _engineForTesting={engine}
      />,
    );

    engine.emit(SCAN_EV.SCAN_PROGRESS, { scanned: 3, total: 10 });
    await flushAsync();

    let plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Scanning');
    expect(plain).toContain('3/10');

    engine.emit(SCAN_EV.SCAN_DONE, { scanId, totals: scans.computeTotals(scanId), durationMs: 1 });
    await flushAsync();

    plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Scan Report');
  });

  // -------------------------------------------------------------------------
  // mode="run" with an injected engine — error path
  // -------------------------------------------------------------------------

  it('shows "Scan failed" and the error message when ERROR is emitted (run mode)', async () => {
    const scans = new ScanRepo(db);
    const folders = new FolderRepo(db);
    const settings = new SettingsRepo(db);
    const engine = new ScanEngine({ scans, folders, settings });

    const { lastFrame } = render(
      <ScanScreen
        db={db}
        mode="run"
        onHome={() => {}}
        onBack={() => {}}
        _engineForTesting={engine}
      />,
    );

    engine.emit(SCAN_EV.ERROR, { message: 'boom' });
    await flushAsync();

    const plain = stripAnsi(lastFrame()!);
    expect(plain).toContain('Scan failed');
    expect(plain).toContain('boom');
  });

  // -------------------------------------------------------------------------
  // Auto-export to Excel (report phase, run + view modes)
  //
  // These tests write real files via the real `exceljs` package. To avoid
  // touching the real developer/CI home directory (~/.memoriahub/exports),
  // HOME/USERPROFILE are redirected to a fresh temp dir for the duration of
  // each test in this block, and exportsDir() (imported above) is checked
  // to see whether it actually resolves under that temp dir before relying
  // on fs.existsSync.
  //
  // NOTE on isolation in THIS environment: empirically verified that under
  // this package's Jest config — ts-jest ESM output executed via Node's
  // `--experimental-vm-modules` — `os.homedir()` does NOT observe
  // process.env.HOME/USERPROFILE mutations performed from a test file (this
  // was reproduced with a bare `os.homedir()` call with no ScanScreen/
  // paths.ts involved at all, so it is not specific to how paths.ts imports
  // `os` — it's a quirk of how the ESM binding for the `os` builtin is wired
  // up under `--experimental-vm-modules`). It's also not an ordering issue we
  // can work around from within this single file: this file already
  // statically imports ScanScreen at module top for the tests above, so
  // re-linking its module graph against a mocked `paths.js` would require
  // `jest.resetModules()`/`jest.isolateModulesAsync()`, which was verified to
  // break Ink/React here (a second `react` module instance gets linked, and
  // Ink's reconciler — bound to the first instance's dispatcher — can no
  // longer find hooks state, throwing "Cannot read properties of null
  // (reading 'useState')"). Because of that, the exportExcel closure inside
  // ScanScreen still writes to the REAL exportsDir() (e.g.
  // `/root/.memoriahub/exports`) in this environment even with HOME
  // overridden. Per the task's documented fallback for this exact scenario,
  // the on-disk fs.existsSync assertion is made conditional on exportsDir()
  // actually resolving under the temp dir, and falls back to asserting only
  // the rendered "Excel saved:" frame text otherwise. Regardless of which
  // branch is taken, the afterEach hook deletes whatever file was actually
  // produced at the REAL exportsDir() path so no stray file is left behind
  // when isolation doesn't take effect.
  // -------------------------------------------------------------------------

  describe('Excel auto-export', () => {
    let tmpHome: string;
    let originalHome: string | undefined;
    let originalUserProfile: string | undefined;
    let producedScanId: number | undefined;

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'memoriahub-test-home-'));
      originalHome = process.env.HOME;
      originalUserProfile = process.env.USERPROFILE;
      process.env.HOME = tmpHome;
      process.env.USERPROFILE = tmpHome;
      producedScanId = undefined;
    });

    afterEach(() => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;

      // Belt-and-suspenders cleanup: if the HOME override didn't take effect
      // in this environment, the export closure wrote to the REAL
      // exportsDir() rather than the temp dir. Remove that file so no stray
      // artifact is left in the real home directory.
      if (producedScanId !== undefined) {
        const realOutPath = path.join(exportsDir(), `scan-${producedScanId}.xlsx`);
        if (fs.existsSync(realOutPath)) fs.rmSync(realOutPath, { force: true });
      }

      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it('auto-exports an Excel workbook and shows the saved path (run mode)', async () => {
      const scanId = seedCompletedScan(db);
      producedScanId = scanId;

      const scans = new ScanRepo(db);
      const folders = new FolderRepo(db);
      const settings = new SettingsRepo(db);
      const engine = new ScanEngine({ scans, folders, settings });

      // Whether the HOME override actually redirects exportsDir() in this
      // Jest/ts-jest environment. See the NOTE above this describe block.
      const isolated = exportsDir() === path.join(tmpHome, '.memoriahub', 'exports');

      const { lastFrame } = render(
        <ScanScreen
          db={db}
          mode="run"
          onHome={() => {}}
          onBack={() => {}}
          _engineForTesting={engine}
        />,
      );

      engine.emit(SCAN_EV.SCAN_DONE, {
        scanId,
        totals: scans.computeTotals(scanId),
        durationMs: 1,
      });

      // exceljs writeFile is real async file I/O — give it more than the
      // default 50ms settle.
      await flushAsync(300);

      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('Excel saved:');
      expect(plain).toContain(`scan-${scanId}.xlsx`);

      if (!isolated) return; // fallback: frame-text assertions above are sufficient

      const outPath = path.join(exportsDir(), `scan-${scanId}.xlsx`);
      expect(fs.existsSync(outPath)).toBe(true);

      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(outPath);
      const sheetNames = wb.worksheets.map((w: { name: string }) => w.name);
      expect(sheetNames).toContain('Summary');
      expect(sheetNames).toContain('Detail');
    });

    it('auto-exports an Excel workbook and shows the saved path (view mode)', async () => {
      const scanId = seedCompletedScan(db);
      producedScanId = scanId;

      const isolated = exportsDir() === path.join(tmpHome, '.memoriahub', 'exports');

      const { lastFrame } = render(
        <ScanScreen db={db} mode="view" onHome={() => {}} onBack={() => {}} />,
      );

      await flushAsync(300);

      const plain = stripAnsi(lastFrame()!);
      expect(plain).toContain('Excel saved:');
      expect(plain).toContain(`scan-${scanId}.xlsx`);

      if (!isolated) return; // fallback: frame-text assertions above are sufficient

      const outPath = path.join(exportsDir(), `scan-${scanId}.xlsx`);
      expect(fs.existsSync(outPath)).toBe(true);
    });
  });
});
