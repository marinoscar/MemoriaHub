import * as fs from 'fs';
import { ApiClient } from './api.js';

export interface UploadResult {
  objectId: string;
}

interface InitUploadResponse {
  objectId: string;
  uploadId: string;
  partSize: number;
  totalParts: number;
  presignedUrls: Array<{ partNumber: number; url: string }>;
}

interface PartUrlsResponse {
  presignedUrls: Array<{ partNumber: number; url: string }>;
}

/** Minimal shape we care about from GET /api/storage/objects/:id/upload/status */
interface UploadStatusResponse {
  uploadId?: string;
  status?: string;
}

const BATCH_PART_URLS = 50; // how many part numbers to request at once

// ---------------------------------------------------------------------------
// Durable multipart resume interfaces
// ---------------------------------------------------------------------------

/**
 * The persisted state that allows resuming a multipart upload after a crash.
 * Returned by UploadPersistence.getResumeState() when a previous run was
 * interrupted and the state is still available in the local SQLite ledger.
 */
export interface UploadResumeState {
  /** storage_object_id from the server's /upload/init response. */
  objectId: string;
  /** Opaque upload-session identifier from the server's /upload/init response. */
  uploadId: string;
  /** Byte length of each part (last part may be smaller). */
  partSize: number;
  /** Parts that were successfully PUT and confirmed by the storage provider. */
  completedParts: Array<{ partNumber: number; eTag: string }>;
}

/**
 * Callbacks that uploadFile calls to persist upload progress to the local
 * ledger so uploads can be resumed across crashes.
 *
 * All methods are synchronous (better-sqlite3 is synchronous) so they never
 * block the event loop.
 */
export interface UploadPersistence {
  /**
   * Called once after the server creates a new upload session, before any
   * parts are uploaded.  The implementation should persist objectId, uploadId,
   * and partSize so the resume state is available even if the CLI crashes
   * before uploading a single part.
   */
  onInit(objectId: string, uploadId: string, partSize: number): void;

  /**
   * Called immediately after a presigned PUT succeeds and the storage provider
   * returns an ETag.  The implementation must persist the (partNumber, eTag)
   * pair durably before returning so that a crash never loses a confirmed part.
   */
  onPartComplete(partNumber: number, eTag: string): void;

  /**
   * Called after the upload is fully complete (either successfully finalized
   * on the server, or the server session was found to have expired so the
   * in-progress state is no longer valid).  The implementation should delete
   * all persisted part rows and clear the upload_id / upload_part_size columns
   * on the file row.
   */
  onComplete(): void;

  /**
   * Return the persisted in-progress state for the current file, or null if
   * no interrupted upload was recorded (fresh file or already completed).
   */
  getResumeState(): UploadResumeState | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read a slice of a file into a Buffer.
 */
function readFileSlice(
  filePath: string,
  start: number,
  length: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = fs.createReadStream(filePath, {
      start,
      end: start + length - 1, // end is inclusive in createReadStream
    });
    stream.on('data', (chunk) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Upload one part. Transient/throttle retries (429/503/5xx/network) are owned
 * by ApiClient.putRaw via the shared retry + cooldown machinery; here we only
 * add part-number context to a terminal failure. Returns the ETag.
 */
async function uploadPart(
  api: ApiClient,
  url: string,
  buffer: Buffer,
  partNumber: number,
  mimeType: string,
): Promise<string> {
  try {
    return await api.putRaw(url, buffer, mimeType);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Part ${partNumber} failed: ${msg}`);
  }
}

/**
 * Fetch presigned URLs for a batch of part numbers from the server.
 */
async function fetchPartUrls(
  api: ApiClient,
  objectId: string,
  partNumbers: number[],
): Promise<Map<number, string>> {
  const resp = await api.post<PartUrlsResponse>(
    `/api/storage/objects/${objectId}/upload/part-urls`,
    { partNumbers },
  );
  const map = new Map<number, string>();
  for (const { partNumber, url } of resp.presignedUrls) {
    map.set(partNumber, url);
  }
  return map;
}

/**
 * Check whether a server-side upload session is still active.
 *
 * Returns true when the server confirms the session is valid (2xx response
 * with a matching uploadId).  Returns false on 404, any HTTP error, network
 * failure, or a mismatched uploadId — in all of those cases the caller should
 * discard the persisted state and start a fresh upload.
 */
async function isServerSessionValid(
  api: ApiClient,
  objectId: string,
  expectedUploadId: string,
): Promise<boolean> {
  try {
    const status = await api.get<UploadStatusResponse>(
      `/api/storage/objects/${objectId}/upload/status`,
    );
    // If the server returns an uploadId, verify it matches what we persisted.
    // If the response has no uploadId field, treat the session as valid (the
    // server accepted the request, so the object exists and is still uploading).
    if (status.uploadId !== undefined && status.uploadId !== expectedUploadId) {
      return false;
    }
    // Treat terminal statuses as invalid (upload already completed or aborted).
    const s = status.status;
    if (s === 'completed' || s === 'failed' || s === 'aborted') {
      return false;
    }
    return true;
  } catch {
    // 404, network error, or any other failure → session is gone.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Upload a file using the resumable multipart upload flow.
 *
 * Flow:
 *   1. If `persistence` provides resume state, validate the server session.
 *      - Valid session: skip already-completed parts, continue from there.
 *      - Expired/missing session: clear persisted state, fall through to init.
 *   2. If no valid resume state: POST /api/storage/objects/upload/init
 *      → objectId, partSize, totalParts, first ≤10 presigned URLs.
 *   3. For each remaining part:
 *      - Use URL from init response if available (parts 1–BATCH_PART_URLS)
 *      - Otherwise batch-fetch via POST :id/upload/part-urls
 *      - PUT the part slice directly to the presigned URL
 *      - Call persistence.onPartComplete(partNumber, eTag) immediately.
 *   4. POST :id/upload/complete with the full merged part list.
 *   5. Call persistence.onComplete() to clear in-progress state.
 */
export async function uploadFile(
  api: ApiClient,
  filePath: string,
  mimeType: string,
  onProgress?: (fraction: number) => void,
  persistence?: UploadPersistence,
): Promise<UploadResult> {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const fileName = filePath.split('/').pop() ?? filePath;

  // Definite-assignment assertions: TypeScript cannot track that either the
  // resume branch or the init branch always assigns these before use, so we
  // use ! to inform it.  The runtime logic guarantees assignment in all paths.
  let objectId!: string;
  let partSize!: number;
  let totalParts!: number;
  const urlCache = new Map<number, string>();
  // Merged list of ALL completed parts (resumed + newly uploaded).
  const completedParts: Array<{ partNumber: number; eTag: string }> = [];
  // Set of part numbers that were already done before this invocation.
  const resumedSet = new Set<number>();

  // ------------------------------------------------------------------
  // 1. Attempt to resume an interrupted upload
  // ------------------------------------------------------------------
  const resumeState = persistence?.getResumeState() ?? null;
  let resumed = false;

  if (resumeState) {
    const valid = await isServerSessionValid(
      api,
      resumeState.objectId,
      resumeState.uploadId,
    );

    if (valid) {
      objectId = resumeState.objectId;
      partSize = resumeState.partSize;
      totalParts = Math.ceil(fileSize / partSize);

      // Seed completedParts with the already-confirmed parts.
      for (const p of resumeState.completedParts) {
        completedParts.push(p);
        resumedSet.add(p.partNumber);
      }

      resumed = true;
    } else {
      // Server session is gone — discard persisted state so the next phase
      // can start a clean upload without stale part rows interfering.
      persistence?.onComplete();
    }
  }

  // ------------------------------------------------------------------
  // 2. Fresh init (no resume state, or server session was expired)
  // ------------------------------------------------------------------
  if (!resumed) {
    const init = await api.post<InitUploadResponse>(
      '/api/storage/objects/upload/init',
      { name: fileName, size: fileSize, mimeType },
    );

    objectId = init.objectId;
    partSize = init.partSize;
    totalParts = init.totalParts;

    // Seed URL cache with the presigned URLs from the init response.
    for (const { partNumber, url } of init.presignedUrls) {
      urlCache.set(partNumber, url);
    }

    // Persist the session identifiers so a crash now still leaves enough
    // information to validate the session on the next attempt.
    persistence?.onInit(objectId, init.uploadId, partSize);
  }

  // ------------------------------------------------------------------
  // 3. Upload each part (skipping already-completed ones on resume)
  // ------------------------------------------------------------------
  for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
    // Skip parts that were confirmed in a previous (crashed) run.
    if (resumedSet.has(partNumber)) {
      if (onProgress) {
        onProgress(partNumber / totalParts);
      }
      continue;
    }

    // Ensure a presigned URL is available; batch-fetch if needed.
    if (!urlCache.has(partNumber)) {
      const need: number[] = [];
      for (
        let n = partNumber;
        n <= Math.min(totalParts, partNumber + BATCH_PART_URLS - 1);
        n++
      ) {
        // Don't request URLs for parts that are already done.
        if (!urlCache.has(n) && !resumedSet.has(n)) {
          need.push(n);
        }
      }
      if (need.length > 0) {
        const fetched = await fetchPartUrls(api, objectId, need);
        for (const [n, u] of fetched) {
          urlCache.set(n, u);
        }
      }
    }

    const url = urlCache.get(partNumber)!;
    const start = (partNumber - 1) * partSize;
    const length = Math.min(partSize, fileSize - start);
    const buffer = await readFileSlice(filePath, start, length);

    const eTag = await uploadPart(api, url, buffer, partNumber, mimeType);
    completedParts.push({ partNumber, eTag });

    // Persist immediately so a crash after this PUT is not wasted.
    persistence?.onPartComplete(partNumber, eTag);

    if (onProgress) {
      onProgress(partNumber / totalParts);
    }
  }

  // ------------------------------------------------------------------
  // 4. Finalize the upload on the server
  // ------------------------------------------------------------------
  await api.post(`/api/storage/objects/${objectId}/upload/complete`, {
    parts: completedParts,
  });

  // ------------------------------------------------------------------
  // 5. Clear in-progress state now that the upload is fully committed
  // ------------------------------------------------------------------
  persistence?.onComplete();

  return { objectId };
}
