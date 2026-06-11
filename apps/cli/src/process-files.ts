import * as path from 'path';
import * as cliProgress from 'cli-progress';
import { ApiClient, ApiError } from './api';
import { sha256File } from './hash';
import { uploadFile } from './upload';
import { Manifest, ManifestEntry } from './manifest';

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

  const bar = new cliProgress.SingleBar(
    {
      format: 'Progress |{bar}| {value}/{total} files  {filename}',
      clearOnComplete: false,
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic,
  );

  bar.start(filePaths.length, 0, { filename: '' });

  for (let i = 0; i < filePaths.length; i++) {
    const { filePath, mimeType } = filePaths[i];
    const basename = path.basename(filePath);
    bar.update(i, { filename: basename });

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
        continue;
      }

      if (dryRun) {
        result.dryRunWouldUpload.push(filePath);
        result.uploaded++;
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
        console.error(`\nFailed to upload ${basename}: ${msg}`);
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
        console.error(`\nFailed to register media for ${basename}: ${msg}`);
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\nUnexpected error processing ${basename}: ${msg}`);
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

  bar.update(filePaths.length, { filename: 'done' });
  bar.stop();

  return result;
}

export function printSummary(
  result: ProcessResult,
  dryRun: boolean,
): void {
  if (dryRun) {
    console.log('\n--- Dry-run summary ---');
    console.log(`Would upload : ${result.dryRunWouldUpload.length} file(s)`);
    console.log(`Dedup match  : ${result.dryRunDedups.length} file(s) (already on server)`);
    if (result.dryRunWouldUpload.length > 0) {
      console.log('\nFiles that would be uploaded:');
      for (const f of result.dryRunWouldUpload) {
        console.log(`  + ${f}`);
      }
    }
    if (result.dryRunDedups.length > 0) {
      console.log('\nFiles already on server (dedup):');
      for (const f of result.dryRunDedups) {
        console.log(`  = ${f}`);
      }
    }
    return;
  }

  const total = result.uploaded + result.skipped + result.failed;
  console.log('\n--- Summary ---');
  console.log(`Total files  : ${total}`);
  console.log(`Uploaded     : ${result.uploaded}`);
  console.log(`Skipped      : ${result.skipped} (already on server)`);
  console.log(`Failed       : ${result.failed}`);
}
