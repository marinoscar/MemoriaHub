/**
 * reports/registry.ts — Single source of truth for all available reports.
 *
 * The registry is shared by the headless CLI (`reports` command) and the
 * future Ink TUI. Add a new report by implementing a ReportDef and appending
 * it to REPORTS below.
 */

import type { ReportDef } from './types.js';
import { overviewReport } from './overview.js';
import { runsReport } from './runs.js';
import { storageReport } from './storage.js';
import { duplicatesReport } from './duplicates.js';

export const REPORTS: ReportDef[] = [
  overviewReport,
  runsReport,
  storageReport,
  duplicatesReport,
];

/** Look up a report by its id. Returns undefined when not found. */
export function getReport(id: string): ReportDef | undefined {
  return REPORTS.find((r) => r.id === id);
}
