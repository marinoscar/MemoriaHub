/**
 * sync/sync-report.ts — Collect a per-run sync report from engine events.
 *
 * The SyncEngine is UI-free and doesn't track a full per-file result list, so
 * this small collector subscribes to its events during a run, records each
 * file's outcome, and — at run:done — builds a SyncReport by enriching those
 * outcomes with the file rows from the DB (size, mime, hash, media item id).
 *
 * Used by both the interactive dashboard and the headless `sync` command to
 * auto-write an Excel workbook for the run.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { EV } from './events.js';
import type { SyncEngine } from './sync-engine.js';
import type { FileRepo } from '../repo/files.js';
import type { FolderRepo } from '../repo/folders.js';
import type { RunRepo } from '../repo/runs.js';
import { exportsDir } from '../paths.js';
import { exportSyncReport } from '../export/sync-export.js';

export type SyncFileStatus = 'uploaded' | 'skipped' | 'failed' | 'would-upload';

/** Map a FILE_SKIPPED reason to the label recorded in the Excel report. */
function skipReasonLabel(reason: 'dedup' | 'unchanged' | 'out_of_range'): string {
  switch (reason) {
    case 'dedup':        return 'dedup';
    case 'unchanged':    return 'unchanged';
    case 'out_of_range': return 'out of date range';
    default:             return reason;
  }
}

export interface SyncFileRow {
  filePath: string;
  status: SyncFileStatus;
  /** Skip reason ('dedup' | 'unchanged' | 'out of date range') or failure message; null otherwise. */
  detail: string | null;
  sizeBytes: number | null;
  mimeType: string | null;
  mediaKind: 'photo' | 'video' | null;
  sha256: string | null;
  mediaItemId: string | null;
}

export interface SyncReport {
  runId: number;
  trigger: string;
  dryRun: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number;
  folderPaths: string[];
  stats: { uploaded: number; skipped: number; failed: number; total: number };
  /** Sum of sizes of successfully uploaded files, in bytes. */
  uploadedBytes: number;
  files: SyncFileRow[];
}

interface Outcome {
  status: SyncFileStatus;
  detail: string | null;
}

function mimeToKind(mime: string | null): 'photo' | 'video' | null {
  if (!mime) return null;
  return mime.startsWith('video/') ? 'video' : 'photo';
}

export class SyncReportCollector {
  private readonly outcomes = new Map<number, Outcome>();
  private runId = 0;
  private dryRun = false;
  private folderIds: number[] = [];
  private total = 0;
  private stats = { uploaded: 0, skipped: 0, failed: 0 };
  private durationMs = 0;

  constructor(
    private readonly files: FileRepo,
    private readonly folders: FolderRepo,
    private readonly runs: RunRepo,
  ) {}

  /** Subscribe to a SyncEngine's events for the duration of a run. */
  attach(engine: SyncEngine): void {
    engine.on(EV.RUN_START, (p) => {
      this.runId = p.runId;
      this.dryRun = p.dryRun;
      this.folderIds = p.folderIds;
      this.total = p.total;
    });
    engine.on(EV.FILE_DONE, (p) => {
      this.outcomes.set(p.fileId, {
        status: p.dryRun ? 'would-upload' : 'uploaded',
        detail: null,
      });
    });
    engine.on(EV.FILE_SKIPPED, (p) => {
      this.outcomes.set(p.fileId, { status: 'skipped', detail: skipReasonLabel(p.reason) });
    });
    engine.on(EV.FILE_FAILED, (p) => {
      this.outcomes.set(p.fileId, { status: 'failed', detail: p.error });
    });
    engine.on(EV.RUN_DONE, (p) => {
      this.stats = { ...p.stats };
      this.durationMs = p.durationMs;
    });
  }

  /** Build the report from collected outcomes + current DB rows. */
  build(): SyncReport {
    const run = this.runs.getById(this.runId);
    const files: SyncFileRow[] = [];
    let uploadedBytes = 0;

    for (const [fileId, outcome] of this.outcomes) {
      const rec = this.files.getById(fileId);
      const sizeBytes = rec?.size_bytes ?? null;
      if (outcome.status === 'uploaded' && sizeBytes) uploadedBytes += sizeBytes;
      files.push({
        filePath: rec?.file_path ?? `#${fileId}`,
        status: outcome.status,
        detail: outcome.detail,
        sizeBytes,
        mimeType: rec?.mime_type ?? null,
        mediaKind: mimeToKind(rec?.mime_type ?? null),
        sha256: rec?.sha256 ?? null,
        mediaItemId: rec?.media_item_id ?? null,
      });
    }
    files.sort((a, b) => a.filePath.localeCompare(b.filePath));

    const folderPaths = this.folderIds.map(
      (id) => this.folders.getById(id)?.path ?? `folder #${id}`,
    );

    return {
      runId: this.runId,
      trigger: run?.trigger ?? '',
      dryRun: this.dryRun,
      startedAt: run?.started_at ?? null,
      finishedAt: run?.finished_at ?? null,
      durationMs: this.durationMs,
      folderPaths,
      stats: { ...this.stats, total: this.total },
      uploadedBytes,
      files,
    };
  }
}

export type WriteSyncReportResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Build the report from a collector and write an Excel workbook to
 * `~/.memoriahub/exports/sync-<runId>.xlsx`. Never throws.
 */
export async function writeSyncReport(
  collector: SyncReportCollector,
): Promise<WriteSyncReportResult> {
  try {
    const report = collector.build();
    if (report.runId <= 0) {
      return { ok: false, error: 'no run recorded' };
    }
    const dir = exportsDir();
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, `sync-${report.runId}.xlsx`);
    await exportSyncReport(report, outPath);
    return { ok: true, path: outPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
