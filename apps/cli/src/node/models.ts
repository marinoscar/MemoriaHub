/**
 * node/models.ts — Worker-node model manager.
 *
 * Ensures the model files listed in the server manifest are present in the local
 * models directory before the node starts processing. Each file is downloaded
 * (streamed) to a temp path, optionally verified by size/sha256, then atomically
 * renamed into place. Existing valid files are left untouched.
 *
 * On success `process.env.MODELS_DIR` (and `FACE_HUMAN_MODEL_PATH`) are pointed
 * at the local directory so the compute libraries load models from disk rather
 * than re-downloading.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { modelsDir as defaultModelsDir } from '../paths.js';
import { sha256File } from '../hash.js';
import { withRetry, DEFAULT_RETRY_CONFIG } from '../http/retry.js';
import { downloadToFile } from './download.js';
import type { ModelManifestEntry } from '../api.js';

export interface EnsureModelsResult {
  /** Absolute directory models were ensured into. */
  targetDir: string;
  /** Names of files downloaded this run. */
  downloaded: string[];
  /** Names of files already present (and valid) — skipped. */
  present: string[];
  /** Files that failed to download/verify. */
  failed: Array<{ name: string; error: string }>;
}

/** Resolve the absolute destination path for a manifest entry. */
function destFor(targetDir: string, entry: ModelManifestEntry): string {
  return path.join(targetDir, entry.targetSubdir ?? '', entry.name);
}

/** True when an existing file satisfies the manifest's size/sha256 checks. */
async function isValid(dest: string, entry: ModelManifestEntry): Promise<boolean> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dest);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size === 0) return false;
  if (entry.bytes != null && stat.size !== entry.bytes) return false;
  if (entry.sha256) {
    const actual = await sha256File(dest);
    if (actual.toLowerCase() !== entry.sha256.toLowerCase()) return false;
  }
  return true;
}

/**
 * Ensure every manifest entry is present and valid under `targetDir`.
 *
 * Downloads missing/invalid files with retry, verifies size+sha256 when the
 * manifest supplies them (skips verification when null), and renames atomically.
 * Never throws for a single failed file — failures are collected in the result
 * so `node doctor` / `node start` can surface them. Sets MODELS_DIR and
 * FACE_HUMAN_MODEL_PATH env vars pointing at the local directory.
 */
export async function ensureModels(
  manifest: ModelManifestEntry[],
  targetDir: string = defaultModelsDir(),
): Promise<EnsureModelsResult> {
  const result: EnsureModelsResult = {
    targetDir,
    downloaded: [],
    present: [],
    failed: [],
  };

  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of manifest) {
    const dest = destFor(targetDir, entry);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    try {
      if (await isValid(dest, entry)) {
        result.present.push(entry.name);
        continue;
      }

      const tmp = `${dest}.partial`;
      try {
        await withRetry(async () => {
          await downloadToFile(entry.url, tmp);
        }, DEFAULT_RETRY_CONFIG);

        if (!(await isValid(tmp, entry))) {
          // Verification failed after download.
          try {
            fs.unlinkSync(tmp);
          } catch {
            /* best-effort */
          }
          throw new Error('downloaded file failed size/sha256 verification');
        }

        // Atomic rename with cross-device fallback.
        try {
          fs.renameSync(tmp, dest);
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
            fs.copyFileSync(tmp, dest);
            fs.unlinkSync(tmp);
          } else {
            throw err;
          }
        }
        result.downloaded.push(entry.name);
      } catch (err) {
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch {
          /* best-effort */
        }
        throw err;
      }
    } catch (err) {
      result.failed.push({
        name: entry.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Point the compute libraries at the local model directory.
  process.env['MODELS_DIR'] = targetDir;
  // Human WASM face model path — best-effort hint; a missing entry is fine.
  const humanEntry = manifest.find((e) => /human/i.test(e.name) || /human/i.test(e.targetSubdir));
  if (humanEntry) {
    process.env['FACE_HUMAN_MODEL_PATH'] = path.dirname(destFor(targetDir, humanEntry));
  } else {
    process.env['FACE_HUMAN_MODEL_PATH'] = targetDir;
  }

  return result;
}
