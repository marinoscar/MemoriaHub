/**
 * backup/download.ts — Verified, resumable, bandwidth-capped downloads for the
 * backup engine (issue #316, epic #308).
 *
 * Template: the VERIFIED model downloads in src/node/models.ts (temp file →
 * verify → atomic rename), not the bare src/node/download.ts — plus three
 * additions that matter for multi-GB media over flaky links:
 *
 *  - sha256 computed WHILE streaming (never a second read pass over the file);
 *  - Range resume: an existing `<id>.part` of size N continues with
 *    `Range: bytes=N-` after re-hashing the partial bytes; a server that
 *    answers 200 instead of 206 restarts from zero (truncate + fresh hash);
 *  - a shared TokenBucket caps the AGGREGATE download rate across the pool.
 *
 * Hash mismatch policy: delete the .part and re-download ONCE from zero; a
 * second mismatch throws HashMismatchError (the engine marks the item failed).
 *
 * Expired presigned URLs (403 / AccessDenied) throw PresignExpiredError so the
 * engine can re-fetch the SAME feed page (URLs are minted per page; the cursor
 * has not moved, so the re-fetch is idempotent).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ApiClient, GetRawAttemptConfig } from '../api.js';
import { ApiError } from '../api.js';
import { renameWithFallback } from './layout.js';
import type { TokenBucket } from './rate-limiter.js';

/** Downloaded bytes hash-verified against contentHash and failed twice. */
export class HashMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`Downloaded bytes failed sha256 verification (expected ${expected}, got ${actual})`);
    this.name = 'HashMismatchError';
  }
}

/** The presigned download URL has expired (403 / AccessDenied). */
export class PresignExpiredError extends Error {
  constructor(message = 'Presigned download URL expired') {
    super(message);
    this.name = 'PresignExpiredError';
  }
}

/** Body/message substrings that mean the presigned URL is no longer valid. */
const PRESIGN_EXPIRED_RE = /AccessDenied|Request has expired|X-Amz-Expires|expired/i;

export interface VerifiedDownloadInput {
  url: string;
  /** Absolute FINAL destination path (renamed into place on success). */
  destAbsPath: string;
  /** Absolute in-flight `.part` path (same filesystem as the final rename target
   * is not required — rename falls back to copy+unlink across devices). */
  partAbsPath: string;
  /** Expected sha256 hex, or null to skip verification. */
  contentHash: string | null;
  signal?: AbortSignal;
}

export interface VerifiedDownloadDeps {
  api: Pick<ApiClient, 'getRaw'>;
  bucket: TokenBucket;
}

export interface VerifiedDownloadResult {
  /** Final on-disk byte size. */
  bytes: number;
  /** sha256 hex of the full file. */
  sha256: string;
}

/** Stream an existing file's bytes into a hash (partial-resume re-hash). */
function hashFileInto(hash: crypto.Hash, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk as Buffer));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
}

function statSizeSafe(filePath: string): number {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

function rmSafe(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Download `url` into `partAbsPath` (resuming when a partial exists and
 * `allowResume` is set), returning the sha256 of the complete on-disk bytes.
 * Each retry ATTEMPT recomputes its Range start and re-hashes whatever bytes
 * are on disk at that moment, so mid-stream retries never double-hash.
 */
async function downloadPass(
  input: VerifiedDownloadInput,
  deps: VerifiedDownloadDeps,
  allowResume: boolean,
): Promise<string> {
  // Holder mutated by each attempt so the digest survives getRaw resolving.
  let hash: crypto.Hash = crypto.createHash('sha256');

  if (!allowResume) rmSafe(input.partAbsPath);

  const attempt = async (): Promise<GetRawAttemptConfig> => {
    hash = crypto.createHash('sha256');
    let rangeStart = 0;
    if (allowResume) {
      const partial = statSizeSafe(input.partAbsPath);
      if (partial > 0) {
        await hashFileInto(hash, input.partAbsPath);
        rangeStart = partial;
      }
    }
    return {
      rangeStart,
      onResponse: ({ resumed }) => {
        // 200 fallback while a Range was requested: getRaw truncates the file
        // (flags 'w'); the hash must restart from zero too.
        if (!resumed) hash = crypto.createHash('sha256');
      },
      onChunk: async (chunk) => {
        await deps.bucket.take(chunk.length);
        hash.update(chunk);
      },
    };
  };

  try {
    await deps.api.getRaw(input.url, input.partAbsPath, {
      signal: input.signal,
      attempt,
    });
  } catch (err) {
    if (
      err instanceof ApiError &&
      (err.status === 403 || PRESIGN_EXPIRED_RE.test(err.serverMessage))
    ) {
      throw new PresignExpiredError(
        `Presigned download URL rejected (HTTP ${err.status}): ${err.serverMessage}`,
      );
    }
    throw err;
  }

  return hash.digest('hex');
}

/**
 * Download with resume + streaming sha256 + hash verification, then atomically
 * rename the `.part` into its final place. On a hash mismatch the partial is
 * deleted and ONE full re-download is attempted before HashMismatchError.
 */
export async function downloadVerified(
  input: VerifiedDownloadInput,
  deps: VerifiedDownloadDeps,
): Promise<VerifiedDownloadResult> {
  fs.mkdirSync(path.dirname(input.partAbsPath), { recursive: true });

  let digest = await downloadPass(input, deps, true);

  if (input.contentHash !== null && digest.toLowerCase() !== input.contentHash.toLowerCase()) {
    // One full retry from zero — a stale/corrupt partial is the common cause.
    digest = await downloadPass(input, deps, false);
    if (digest.toLowerCase() !== input.contentHash.toLowerCase()) {
      rmSafe(input.partAbsPath);
      throw new HashMismatchError(input.contentHash, digest);
    }
  }

  fs.mkdirSync(path.dirname(input.destAbsPath), { recursive: true });
  renameWithFallback(input.partAbsPath, input.destAbsPath);

  return { bytes: statSizeSafe(input.destAbsPath), sha256: digest };
}
