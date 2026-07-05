/**
 * commands/scan.ts — `memoriahub scan` command group.
 *
 * A pre-sync dry-run: enumerate every file a sync WOULD process, read
 * lightweight metadata (EXIF present? location present?), persist an immutable
 * snapshot in the local DB, and render a dashboard report.  No uploads, no
 * server calls — scan is fully offline and needs no PAT.
 *
 * Subcommands:
 *   memoriahub scan [folder...] [--all] [--json] [--no-report] [-r] [--concurrency <n>]
 *   memoriahub scan list [--json]
 *   memoriahub scan report [id] [--json]
 *   memoriahub scan export <id> --out <file> [--format xlsx|csv]   (see commands/scan-export)
 */

import * as path from 'node:path';
import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { getDb } from '../db/database.js';
import { FolderRepo } from '../repo/folders.js';
import { ScanRepo } from '../repo/scans.js';
import { SettingsRepo } from '../repo/settings.js';
import { ScanEngine } from '../scan/scan-engine.js';
import { SCAN_EV } from '../scan/events.js';
import { buildScanReport } from '../scan/report.js';
import {
  renderScanReportHeadless,
  renderScanReportJson,
} from '../render/headless-scan.js';
import { registerScanExport } from './scan-export.js';
import { ui, isTTY, createSpinner } from '../ui.js';
import { formatBytes } from '../format-bytes.js';

// ---------------------------------------------------------------------------
// Shared: render a report to the best available surface
// ---------------------------------------------------------------------------

async function showReport(
  scanId: number,
  scans: ScanRepo,
  folders: FolderRepo,
  opts: { json: boolean },
): Promise<void> {
  const report = buildScanReport(scans, folders, scanId);

  if (opts.json) {
    renderScanReportJson(report);
    return;
  }

  if (isTTY) {
    // Dynamic import keeps Ink/React out of headless code paths.
    const mod = (await import('../tui/ScanDashboard.js')) as {
      renderScanDashboard: (p: { report: typeof report; serverUrl?: string }) => Promise<void>;
    };
    await mod.renderScanDashboard({ report, serverUrl: loadConfig()?.serverUrl });
    return;
  }

  renderScanReportHeadless(report);
}

// ---------------------------------------------------------------------------
// scan (default action) — run a scan
// ---------------------------------------------------------------------------

interface ScanActionOptions {
  all: boolean;
  json: boolean;
  report: boolean; // commander maps --no-report → report:false
  recursive: boolean;
  concurrency?: number;
}

async function runScan(folderArgs: string[], options: ScanActionOptions): Promise<void> {
  if (folderArgs.length === 0 && !options.all) {
    ui.warn('No folders specified.');
    ui.info('Use `memoriahub scan --all` to scan all registered folders, or pass folder paths.');
    process.exit(1);
  }

  const db = getDb();
  const folderRepo = new FolderRepo(db);
  const scanRepo = new ScanRepo(db);
  const settingsRepo = new SettingsRepo(db);

  // Resolve folder paths → IDs (auto-register unknown paths, like sync).
  let folderIds: number[] | undefined;
  if (folderArgs.length > 0) {
    folderIds = [];
    for (const rawPath of folderArgs) {
      const absPath = path.resolve(rawPath);
      let folder = folderRepo.getByPath(absPath);
      if (!folder) {
        ui.info(`Auto-registering folder: ${absPath}`);
        folder = folderRepo.add({ path: absPath, recursive: options.recursive, enabled: true });
        ui.success(`Registered as folder #${folder.id}`);
      }
      folderIds.push(folder.id);
    }
  }

  const engine = new ScanEngine({
    scans: scanRepo,
    folders: folderRepo,
    settings: settingsRepo,
  });

  // Live progress while scanning (skip when emitting JSON so stdout stays clean).
  const spinner = !options.json ? createSpinner('Scanning…') : null;
  spinner?.start();
  let scannedCount = 0;
  engine.on(SCAN_EV.SCAN_PROGRESS, ({ scanned, total }) => {
    scannedCount = scanned;
    if (spinner) spinner.text = `Scanning… ${scanned}/${total} files`;
  });

  let scanId: number;
  try {
    const result = await engine.run({
      folderIds,
      all: options.all,
      concurrency: options.concurrency,
      trigger: 'cli',
    });
    scanId = result.scanId;
    spinner?.succeed(
      `Scanned ${result.totals.totalFiles} file(s), ${formatBytes(result.totals.totalBytes)} ` +
        `(scan #${result.scanId})`,
    );
    // Surface any present-but-invalid memoriahub.json overrides prominently. The
    // scan does not abort on these (unlike sync) — it reports exactly which file
    // is broken and why so the user can fix it before running a real sync. Kept
    // off stdout in --json mode so scripted output stays clean.
    if (result.overrideErrors.length > 0 && !options.json) {
      ui.warn(
        `${result.overrideErrors.length} folder override(s) were invalid and skipped:`,
      );
      for (const oe of result.overrideErrors) {
        ui.warn(`  ${oe.reason}`);
      }
    }
  } catch (err) {
    spinner?.fail('Scan failed');
    const msg = err instanceof Error ? err.message : String(err);
    ui.error(msg);
    process.exit(1);
  }
  void scannedCount;

  if (options.report) {
    await showReport(scanId, scanRepo, folderRepo, { json: options.json });
  } else if (options.json) {
    // --no-report with --json: still emit the JSON report (report=false only
    // suppresses the interactive dashboard).
    await showReport(scanId, scanRepo, folderRepo, { json: true });
  }
}

// ---------------------------------------------------------------------------
// Command wiring
// ---------------------------------------------------------------------------

export function scanCommand(): Command {
  const cmd = new Command('scan');
  cmd
    .description('Dry-run scan: preview and persist the file set a sync would process')
    .argument('[folder...]', 'Paths to folders to scan (omit to use --all)')
    .option('--all', 'Scan all registered enabled folders', false)
    .option('--json', 'Emit the report as JSON instead of a dashboard', false)
    .option('--no-report', 'Skip rendering the report after scanning')
    .option('-r, --recursive', 'Descend into sub-directories (when auto-registering a folder)', false)
    .option('--concurrency <n>', 'Number of concurrent metadata workers', parseInt)
    .action(runScan);

  // scan list
  cmd
    .command('list')
    .description('List recent scans')
    .option('--json', 'Emit as JSON', false)
    .action((opts: { json: boolean }) => {
      const db = getDb();
      const scans = new ScanRepo(db).listScans(50);
      if (opts.json) {
        process.stdout.write(JSON.stringify(scans, null, 2) + '\n');
        return;
      }
      if (scans.length === 0) {
        ui.info('No scans yet. Run `memoriahub scan --all` to create one.');
        return;
      }
      for (const s of scans) {
        ui.line(
          `#${String(s.id).padEnd(4)} ${s.created_at}  ` +
            `${String(s.total_files).padStart(6)} files  ` +
            `${formatBytes(s.total_bytes).padStart(10)}  ` +
            `${s.photo_count}📷 ${s.video_count}🎞  ` +
            `[${s.status}]`,
        );
      }
    });

  // scan report [id]
  cmd
    .command('report [id]')
    .description('Re-render a stored scan report (default: latest)')
    .option('--json', 'Emit the report as JSON', false)
    .action(async (id: string | undefined, opts: { json: boolean }) => {
      const db = getDb();
      const scanRepo = new ScanRepo(db);
      const folderRepo = new FolderRepo(db);

      let scanId: number | null;
      if (id) {
        scanId = parseInt(id, 10);
        if (isNaN(scanId)) {
          ui.error(`Invalid scan id: ${id}`);
          process.exit(1);
        }
      } else {
        scanId = scanRepo.latestComplete()?.id ?? null;
      }

      if (scanId === null || !scanRepo.getScan(scanId)) {
        ui.error('No scan found. Run `memoriahub scan --all` first.');
        process.exit(1);
      }

      await showReport(scanId, scanRepo, folderRepo, { json: opts.json });
    });

  // scan export <id> --out <file> [--format xlsx|csv]
  registerScanExport(cmd);

  return cmd;
}
