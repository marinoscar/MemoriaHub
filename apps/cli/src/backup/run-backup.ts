/**
 * backup/run-backup.ts — UI-agnostic backup engine.
 *
 * Encapsulates the enumerate → download → skip-if-already-present logic used by
 * `memoriahub backup`, so the same core can be driven by the headless command
 * AND a future Ink TUI screen without duplicating the loop (mirrors the
 * shared sync-engine pattern).
 *
 * This module is presentation-free: it never prints (no `ui.*`, no console)
 * and never calls `process.exit`. It reports progress exclusively through the
 * optional `onProgress` callback and returns a `BackupResult`. Fatal listing
 * failures are thrown for the caller to handle.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ApiClient } from '../api.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BackupOptions {
  /** Circle ID to back up (mutually optional with `all`). */
  circle?: string;
  /** Back up all circles. */
  all?: boolean;
  /** Destination directory for downloaded blobs. */
  dest: string;
}

export interface BackupProgress {
  phase: 'listing' | 'downloading' | 'done';
  /** Total items to process (0 until listed). */
  total: number;
  downloaded: number;
  skipped: number;
  failed: number;
  /** storageKey/path of the item in flight. */
  current?: string;
  /**
   * Per-item detail, present only on per-item events during the
   * 'downloading' phase. Lets a renderer print the exact same per-item lines
   * the headless command emits without re-deriving state.
   */
  item?: {
    originalFilename: string;
    /** Local destination path the blob was written to. */
    localFile: string;
    outcome: 'downloaded' | 'skipped' | 'failed';
    /** Failure message (present only when outcome === 'failed'). */
    error?: string;
  };
}

export interface BackupResult {
  total: number;
  downloaded: number;
  skipped: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Run a backup: enumerate objects via the admin backup API and download each
 * one to `opts.dest/<circleId>/<storageKey>`, skipping any file that already
 * exists at the expected size. Never prints and never exits the process.
 *
 * @throws Error when neither `circle` nor `all` is provided, or when listing
 *   the backup objects fails (caller decides how to surface it).
 */
export async function runBackup(
  api: ApiClient,
  opts: BackupOptions,
  onProgress?: (p: BackupProgress) => void,
): Promise<BackupResult> {
  // Validate options — at least one target must be specified.
  if (!opts.circle && !opts.all) {
    throw new Error('Provide either --circle <id> or --all');
  }

  // Enumerate objects. A failure here is fatal and propagates to the caller.
  const result = await api.listBackupObjects(opts.circle);
  const items = result.items;
  const total = items.length;

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  // Emit once after listing: total is now known, we move into downloading.
  onProgress?.({ phase: 'downloading', total, downloaded, skipped, failed });

  for (const item of items) {
    const localFile = path.join(opts.dest, item.circleId, item.storageKey);
    const localDir = path.dirname(localFile);

    fs.mkdirSync(localDir, { recursive: true });

    // Skip if already exists at the correct size.
    if (fs.existsSync(localFile)) {
      const stat = fs.statSync(localFile);
      if (stat.size === item.size) {
        skipped++;
        onProgress?.({
          phase: 'downloading',
          total,
          downloaded,
          skipped,
          failed,
          current: item.storageKey,
          item: {
            originalFilename: item.originalFilename,
            localFile,
            outcome: 'skipped',
          },
        });
        continue;
      }
    }

    // Download via signed URL.
    try {
      const res = await fetch(item.downloadUrl);
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status}`);
      }

      const writeStream = fs.createWriteStream(localFile);
      const reader = res.body.getReader();

      await new Promise<void>((resolve, reject) => {
        const pump = async (): Promise<void> => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                writeStream.end();
                break;
              }
              if (!writeStream.write(value)) {
                await new Promise<void>((r) => writeStream.once('drain', r));
              }
            }
            writeStream.once('finish', resolve);
            writeStream.once('error', reject);
          } catch (e) {
            reject(e);
          }
        };
        pump().catch(reject);
      });

      downloaded++;
      onProgress?.({
        phase: 'downloading',
        total,
        downloaded,
        skipped,
        failed,
        current: item.storageKey,
        item: {
          originalFilename: item.originalFilename,
          localFile,
          outcome: 'downloaded',
        },
      });
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      onProgress?.({
        phase: 'downloading',
        total,
        downloaded,
        skipped,
        failed,
        current: item.storageKey,
        item: {
          originalFilename: item.originalFilename,
          localFile,
          outcome: 'failed',
          error: msg,
        },
      });
    }
  }

  // Emit the terminal event.
  onProgress?.({ phase: 'done', total, downloaded, skipped, failed });

  return { total, downloaded, skipped, failed };
}
