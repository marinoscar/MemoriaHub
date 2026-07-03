/**
 * commands/scan-export.ts — `memoriahub scan export` subcommand wiring.
 *
 * Kept separate from scan.ts so the exceljs-touching export module and its
 * command surface live together.  The actual workbook/CSV writing is in
 * export/scan-export.ts.
 */

import { Command } from 'commander';
import { getDb } from '../db/database.js';
import { ScanRepo } from '../repo/scans.js';
import { FolderRepo } from '../repo/folders.js';
import { buildScanReport } from '../scan/report.js';
import { exportScan, resolveFormat } from '../export/scan-export.js';
import { ui } from '../ui.js';

/** Attach the `export` subcommand to the parent `scan` command. */
export function registerScanExport(parent: Command): void {
  parent
    .command('export <id>')
    .description('Export a scan report to Excel (.xlsx) or CSV')
    .requiredOption('--out <file>', 'Output file path (extension picks the format)')
    .option('--format <fmt>', 'Force output format: xlsx | csv')
    .action(async (id: string, opts: { out: string; format?: string }) => {
      const scanId = parseInt(id, 10);
      if (isNaN(scanId)) {
        ui.error(`Invalid scan id: ${id}`);
        process.exit(1);
      }
      if (opts.format && opts.format !== 'xlsx' && opts.format !== 'csv') {
        ui.error(`Invalid --format: ${opts.format} (expected xlsx or csv)`);
        process.exit(1);
      }

      const db = getDb();
      const scanRepo = new ScanRepo(db);
      const folderRepo = new FolderRepo(db);

      if (!scanRepo.getScan(scanId)) {
        ui.error(`Scan ${scanId} not found. Run \`memoriahub scan list\` to see available scans.`);
        process.exit(1);
      }

      const format = resolveFormat(opts.out, opts.format);
      const report = buildScanReport(scanRepo, folderRepo, scanId, {
        // Include the full breakdowns in the workbook, not just the top-N.
        cameraLimit: 1000,
        largestLimit: 100,
      });
      const files = scanRepo.listScanFiles(scanId);

      try {
        await exportScan(report, files, opts.out, format);
        ui.success(`Exported scan #${scanId} (${files.length} files) → ${opts.out} [${format}]`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ui.error(`Export failed: ${msg}`);
        process.exit(1);
      }
    });
}
