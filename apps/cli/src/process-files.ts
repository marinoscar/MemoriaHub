import * as path from 'path';
import * as cliProgress from 'cli-progress';
import pc from 'picocolors';
import { ApiClient, ApiError } from './api';
import { sha256File } from './hash';
import { uploadFile } from './upload';
import { Manifest, ManifestEntry } from './manifest';
import { ui, isTTY, printImportSummaryBox } from './ui';

export interface ProcessResult {
  uploaded: number;
  skipped: number;
  failed: number;
  dryRunWouldUpload: string[];
  dryRunDedups: string[];
}

export interface ProcessOptions {
  filePaths: Array<{ filePath: string; mimeType: string }>;
  api: ApiClient;
  manifest: Manifest;
  dryRun: boolean;
}

interface MediaListResponse {
  items: Array<{ id: string; contentHash: string }>;
}

interface MediaItem {
  id: string;
}

/**
 * Core loop: for each file, compute hash, dedup-check, upload, register,
 * update manifest. Used by both `import` and `sync`.
 *
 * Mutates manifest.files in place. Caller is responsible for persisting.
 */
export async function processFiles(opts: ProcessOptions): Promise<ProcessResult> {
  const { filePaths, api, manifest, dryRun } = opts;

  const result: ProcessResult = {
    uploaded: 0,
    skipped: 0,
    failed: 0,
    dryRunWouldUpload: [],
    dryRunDedups: [],
  };

  // Style the progress bar; on non-TTY, cli-progress still works but uses
  // plain ASCII characters (no cursor hide needed).
  const barFormat = isTTY
    ? `  {filename} ${pc.dim('|{bar}|')} {value}/{total}  {percentage}%`
    : '  {filename} [{bar}] {value}/{total}  {percentage}%';

  const bar = new cliProgress.SingleBar(
    {
      format: barFormat,
      barCompleteChar: '█',
      barIncompleteChar: '░',
      clearOnComplete: false,
      hideCursor: isTTY,
      barsize: 25,
    },
  );

  bar.start(filePaths.length, 0, { filename: '' });

  for (let i = 0; i < filePaths.length; i++) {
    const { filePath, mimeType } = filePaths[i];
    const basename = path.basename(filePath);
    // Truncate long filenames so the bar stays on one line
    const label = basename.length > 28 ? basename.slice(0, 27) + '…' : basename.padEnd(28);
    bar.update(i, { filename: label });

    try {
      // Compute SHA-256
      const sha256 = await sha256File(filePath);

      // Dedup check on server
      const mediaList = await api.get<MediaListResponse>(
        `/api/media?contentHash=${encodeURIComponent(sha256)}&pageSize=1`,
      );

      if (mediaList.items.length > 0) {
        const existing = mediaList.items[0];
        if (dryRun) {
          result.dryRunDedups.push(filePath);
        } else {
          // Record in manifest as uploaded (existing item)
          manifest.files[filePath] = {
            sha256,
            mediaItemId: existing.id,
            uploadedAt: new Date().toISOString(),
            status: 'uploaded',
          };
        }
        result.skipped++;
        bar.update(i + 1, { filename: label });
        continue;
      }

      if (dryRun) {
        result.dryRunWouldUpload.push(filePath);
        result.uploaded++;
        bar.update(i + 1, { filename: label });
        continue;
      }

      // Upload the file
      let objectId: string;
      try {
        const uploadResult = await uploadFile(api, filePath, mimeType, (fraction) => {
          // inner progress not shown separately — outer bar advances per file
          void fraction;
        });
        objectId = uploadResult.objectId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        bar.stop();
        ui.error(`Failed to upload ${basename}: ${msg}`);
        bar.start(filePaths.length, i + 1, { filename: label });
        manifest.files[filePath] = {
          sha256,
          mediaItemId: null,
          uploadedAt: null,
          status: 'failed',
        } as ManifestEntry;
        result.failed++;
        continue;
      }

      // Register as MediaItem
      const type = mimeType.startsWith('video/') ? 'video' : 'photo';
      let mediaItem: MediaItem;
      try {
        mediaItem = await api.post<MediaItem>('/api/media', {
          storageObjectId: objectId,
          type,
          source: 'cli',
          originalFilename: basename,
        });
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? `HTTP ${err.status}: ${err.serverMessage}`
            : err instanceof Error
              ? err.message
              : String(err);
        bar.stop();
        ui.error(`Failed to register media for ${basename}: ${msg}`);
        bar.start(filePaths.length, i + 1, { filename: label });
        manifest.files[filePath] = {
          sha256,
          mediaItemId: null,
          uploadedAt: null,
          status: 'failed',
        } as ManifestEntry;
        result.failed++;
        continue;
      }

      manifest.files[filePath] = {
        sha256,
        mediaItemId: mediaItem.id,
        uploadedAt: new Date().toISOString(),
        status: 'uploaded',
      };
      result.uploaded++;
      bar.update(i + 1, { filename: label });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      bar.stop();
      ui.error(`Unexpected error processing ${basename}: ${msg}`);
      bar.start(filePaths.length, i + 1, { filename: label });
      // Mark as pending so it can be retried on next sync
      manifest.files[filePath] = {
        sha256: '',
        mediaItemId: null,
        uploadedAt: null,
        status: 'failed',
      } as ManifestEntry;
      result.failed++;
    }
  }

  bar.update(filePaths.length, { filename: 'done'.padEnd(28) });
  bar.stop();

  return result;
}

/**
 * printSummary is kept for backward compatibility (tests may call it directly).
 * New callers should prefer printImportSummaryBox from ui.ts.
 */
export function printSummary(
  result: ProcessResult,
  dryRun: boolean,
): void {
  printImportSummaryBox({
    uploaded: result.uploaded,
    skipped: result.skipped,
    failed: result.failed,
    dryRun,
    dryRunWouldUpload: result.dryRunWouldUpload.length,
    dryRunDedups: result.dryRunDedups.length,
  });
}
