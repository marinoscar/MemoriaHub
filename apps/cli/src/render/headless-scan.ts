/**
 * render/headless-scan.ts — Terminal renderer for scan reports without Ink.
 *
 * Used for non-TTY output, the `--json` flag, and as the fallback when the Ink
 * dashboard is not appropriate.  Consumes the same ScanReport object the Ink
 * dashboard and Excel export use, so all three surfaces agree.
 *
 * ONLY this file and command files are allowed to print to the terminal.
 */

import chalk from 'chalk';
import Table from 'cli-table3';
import { isTTY, printBox } from '../ui.js';
import { formatBytes } from '../format-bytes.js';
import type { ScanReport } from '../scan/report.js';

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return '…' + s.slice(s.length - (max - 1));
}

/** Emit the report as pretty-printed JSON (for scripting / jq). */
export function renderScanReportJson(report: ScanReport): void {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

/**
 * Render a scan report to the terminal: a KPI + coverage summary box followed
 * by breakdown tables.
 */
export function renderScanReportHeadless(report: ScanReport): void {
  const { scan, kpis, coverage, byFolder, byCamera, largest } = report;

  printBox(
    [
      `Scan #${scan.id}   ${scan.created_at}`,
      '',
      `  Files      : ${chalk.cyan(String(kpis.totalFiles))}` +
        `  (${chalk.green(String(kpis.photoCount))} photo / ${chalk.blue(String(kpis.videoCount))} video)`,
      `  Total size : ${chalk.cyan(formatBytes(kpis.totalBytes))}` +
        `  (${formatBytes(kpis.photoBytes)} photo / ${formatBytes(kpis.videoBytes)} video)`,
      '',
      `  EXIF       : ${coverage.exifCount}/${kpis.totalFiles} (${coverage.exifPct}%)`,
      `  Location   : ${coverage.gpsCount}/${kpis.totalFiles} (${coverage.gpsPct}%)`,
      `  Capture dt : ${coverage.capturedAtCount}/${kpis.totalFiles} (${coverage.capturedAtPct}%)`,
      ...(coverage.metaErrorCount > 0
        ? [`  ${chalk.yellow(`Read errors: ${coverage.metaErrorCount}`)}`]
        : []),
    ],
    'Scan Report',
  );

  if (byFolder.length > 0) {
    const t = new Table({
      head: [chalk.bold('Folder'), chalk.bold('Files'), chalk.bold('Size')],
      colWidths: [46, 9, 12],
      wordWrap: true,
      style: { head: [], border: isTTY ? ['dim'] : [] },
    });
    for (const f of byFolder) {
      t.push([truncate(f.path, 44), String(f.count), formatBytes(f.bytes)]);
    }
    process.stdout.write(t.toString() + '\n');
  }

  if (byCamera.length > 0) {
    const t = new Table({
      head: [chalk.bold('Camera'), chalk.bold('Files')],
      colWidths: [46, 9],
      wordWrap: true,
      style: { head: [], border: isTTY ? ['dim'] : [] },
    });
    for (const c of byCamera) {
      t.push([truncate(c.label, 44), String(c.count)]);
    }
    process.stdout.write(t.toString() + '\n');
  }

  if (largest.length > 0) {
    const t = new Table({
      head: [chalk.bold('Largest files'), chalk.bold('Size')],
      colWidths: [46, 12],
      wordWrap: true,
      style: { head: [], border: isTTY ? ['dim'] : [] },
    });
    for (const l of largest) {
      t.push([truncate(basename(l.path), 44), formatBytes(l.sizeBytes)]);
    }
    process.stdout.write(t.toString() + '\n');
  }
}
