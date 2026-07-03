/**
 * reports/duplicates.ts — Files skipped because the server already had
 * identical content (skip_reason = 'dedup').
 */

import { FileRepo } from '../repo/files.js';
import type { ReportDef, ReportContext, ReportTable } from './types.js';

export const duplicatesReport: ReportDef = {
  id: 'duplicates',
  label: 'Duplicates',
  description: 'Files skipped because the server already had identical content',

  compute(ctx: ReportContext): ReportTable {
    const dupes = new FileRepo(ctx.db).duplicates();

    const rows = dupes.map((f) => [
      f.id,
      f.file_path,
      f.media_item_id ?? '',
    ]);

    return {
      columns: ['ID', 'Path', 'Media item'],
      rows,
      summary: rows.length > 0 ? `${rows.length} duplicate(s) skipped` : '0 duplicates',
    };
  },
};
