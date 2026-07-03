/**
 * reports/runs.ts — Recent sync run history.
 */

import { RunRepo } from '../repo/runs.js';
import type { ReportDef, ReportContext, ReportTable } from './types.js';

function fmtDate(iso: string | null): string {
  if (!iso) return 'never';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function fmtDuration(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return 'running…';
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  return `${(ms / 1000).toFixed(1)}s`;
}

export const runsReport: ReportDef = {
  id: 'runs',
  label: 'Recent runs',
  description: 'Recent sync run history',

  compute(ctx: ReportContext): ReportTable {
    const runRepo = new RunRepo(ctx.db);

    const rows = runRepo.listRuns(20).map((run) => [
      run.id,
      run.trigger,
      fmtDate(run.started_at),
      fmtDuration(run.started_at, run.finished_at),
      run.total,
      run.uploaded,
      run.skipped,
      run.failed,
      run.dry_run ? 'yes' : 'no',
    ]);

    return {
      columns: [
        'ID',
        'Trigger',
        'Started',
        'Duration',
        'Total',
        'Uploaded',
        'Skipped',
        'Failed',
        'Dry?',
      ],
      rows,
    };
  },
};
