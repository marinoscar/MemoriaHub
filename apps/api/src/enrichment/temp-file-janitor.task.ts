// =============================================================================
// Temp-File Janitor Scheduled Task
// =============================================================================
//
// On module init and every hour, delete orphaned MemoriaHub temp files from
// os.tmpdir(). Video enrichment handlers stream downloads and frames to
// `memoriaHub-*` temp files that are normally unlinked in finally blocks —
// but a SIGKILL (e.g. OOM) mid-job skips those blocks and leaks the file. On
// a small VPS a leaked multi-GB video download quickly starves the disk, so
// this task sweeps matching files older than 6 hours (mtime; safely beyond
// the longest legitimate single-job runtime).
//
// Per-file errors are swallowed (best-effort). Only active on instances whose
// enrichment worker runs at all (resolveWorkerMode() !== 'off') since only
// worker instances create these files — note that 'system' mode still sweeps:
// server-only jobs (e.g. a thumbnail_repair full reprocess) still stream
// video downloads to memoriaHub-* temp files.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { tmpdir } from 'os';
import { join } from 'path';
import { promises as fs } from 'fs';
import { resolveWorkerMode } from './enrichment-job.worker';

/** Temp files created by MemoriaHub processing/enrichment code. */
const TEMP_FILE_PREFIX = /^memoriaHub-/;

/** Age (mtime) beyond which an orphaned temp file is deleted. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

@Injectable()
export class TempFileJanitorTask implements OnModuleInit {
  private readonly logger = new Logger(TempFileJanitorTask.name);

  /** Startup sweep — recovers files leaked by a previously SIGKILLed process. */
  async onModuleInit(): Promise<void> {
    await this.sweep();
  }

  @Cron(CronExpression.EVERY_HOUR)
  async handleSweep(): Promise<void> {
    await this.sweep();
  }

  private async sweep(): Promise<void> {
    // Skip only when the enrichment worker is fully off — non-worker instances
    // never create these files. 'system' mode still sweeps: the in-process
    // worker keeps running server-only jobs that write memoriaHub-* temp files.
    if (resolveWorkerMode() === 'off') {
      return;
    }

    const dir = tmpdir();
    const cutoff = Date.now() - MAX_AGE_MS;
    let removed = 0;

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      this.logger.error('Failed to scan temp dir for orphaned files', err as Error);
      return;
    }

    for (const name of entries) {
      if (!TEMP_FILE_PREFIX.test(name)) continue;
      const filePath = join(dir, name);
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
        await fs.unlink(filePath);
        removed++;
      } catch {
        // Best-effort: the file may have been unlinked by its owning job
        // between readdir and here, or be otherwise inaccessible — skip it.
      }
    }

    if (removed > 0) {
      this.logger.log(`Removed ${removed} orphaned temp file(s) older than 6h from ${dir}`);
    }
  }
}
