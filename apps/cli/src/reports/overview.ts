/**
 * reports/overview.ts — Per-folder file counts and last sync time.
 */

import { FolderRepo } from '../repo/folders.js';
import { FileRepo } from '../repo/files.js';
import type { ReportDef, ReportContext, ReportTable } from './types.js';

function fmtDate(iso: string | null): string {
  if (!iso) return 'never';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export const overviewReport: ReportDef = {
  id: 'overview',
  label: 'Folder overview',
  description: 'Per-folder file counts and last sync time',

  compute(ctx: ReportContext): ReportTable {
    const folderRepo = new FolderRepo(ctx.db);
    const fileRepo = new FileRepo(ctx.db);

    const rows = folderRepo.list().map((f) => {
      const counts = fileRepo.counts([f.id]);
      return [
        f.id,
        f.path,
        f.enabled ? 'yes' : 'no',
        fmtDate(f.last_sync_at),
        counts.uploaded,
        counts.queued + counts.uploading,
        counts.failed,
        counts.skipped,
      ];
    });

    return {
      columns: [
        'ID',
        'Path',
        'Enabled',
        'Last sync',
        'Uploaded',
        'Queued',
        'Failed',
        'Skipped',
      ],
      rows,
    };
  },
};
