/**
 * reports/storage.ts — Total bytes and item count of uploaded media.
 */

import { FileRepo } from '../repo/files.js';
import { formatBytes } from '../format-bytes.js';
import type { ReportDef, ReportContext, ReportTable } from './types.js';

export const storageReport: ReportDef = {
  id: 'storage',
  label: 'Storage synced',
  description: 'Total bytes and item count of uploaded media',

  compute(ctx: ReportContext): ReportTable {
    const s = new FileRepo(ctx.db).storageSummary();

    return {
      columns: ['Metric', 'Value'],
      rows: [
        ['Items uploaded', s.items],
        ['Total size', formatBytes(s.totalBytes)],
        ['Average size', formatBytes(s.avgBytes)],
      ],
      summary: `${s.items} item(s), ${formatBytes(s.totalBytes)} uploaded`,
    };
  },
};
