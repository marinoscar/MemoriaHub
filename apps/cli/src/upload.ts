import * as fs from 'fs';
import { ApiClient, ApiError } from './api.js';
import { STALE_SESSION_MESSAGE_RE } from './http/retry.js';

export interface UploadResult {
  objectId: string;
}

/**
 * How a part URL must be authenticated (issue #506).
 *
 * - `none`: a presigned S3/R2 URL. NO Authorization header — S3 rejects one,
 *   and the credential must never leave for a third-party host.
 * - `bearer`: the API's own `PUT /api/storage/objects/:id/upload/parts/:n`
 *   route (the `local` storage provider has no presigned URLs). Sent with this
 *   client's bearer credential, always to its own configured server.
 *
 * Absent on servers older than #506, which only ever hand out presigned URLs,
 * so absent means `none`.
 */
export type PartUploadAuth = 'none' | 'bearer';

interface InitUploadResponse {
  objectId: string;
  uploadId: string;
  partSize: number;
  totalParts: number;
  presignedUrls: Array<{ partNumber: number; url: string }>;
  partUploadAuth?: PartUploadAuth;
}

interface PartUrlsResponse {
  presignedUrls: Array<{ partNumber: number; url: string }>;
  partUploadAuth?: PartUploadAuth;
}

/** Where to PUT one part, and how to authenticate it. */
interface PartTarget {
  url: string;
  auth: PartUploadAuth;
}

/** `details.reason` values the storage API attaches to upload errors. */
const REASON_UPLOAD_PARTS_MISSING = 'UPLOAD_PARTS_MISSING';
const REASON_UPLOAD_SESSION_INVALID = 'UPLOAD_SESSION_INVALID';

/**
 * How many times one upload re-sends parts the server reported missing before
 * giving up. Each round re-sends only the listed parts; needing more than this
 * means something is corrupting parts in transit, not a transient loss.
 */
const MAX_MISSING_PART_ROUNDS = 2;

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
 * Internal signal: the storage provider no longer knows about this multipart
 * upload, so the persisted resume state is worthless and the file must be
 * re-initialized from scratch. Never escapes {@link uploadFile} — it is caught
 * there and converted into one fresh upload session.
 */
class StaleUploadSessionError extends Error {
  constructor(
    /** Where the dead session surfaced — a part PUT, or the complete call. */
    readonly stage: string,
    readonly detail: string,
  ) {
    super(
      `Multipart upload session no longer exists on the storage provider ` +
        `(${stage}): ${detail}`,
    );
    this.name = 'StaleUploadSessionError';
  }
}

/**
 * True when a failed presigned part PUT means the multipart upload itself is
 * gone rather than the part being individually rejected.
 *
 * S3/R2 answer a part PUT with 404 only when the upload or the bucket cannot be
 * found (`NoSuchUpload` / `NoSuchBucket`) — never for a transient condition —
 * so any 404 here invalidates the session. This is what a stranded upload looks
 * like after the provider garbage-collected an abandoned multipart upload while
 * our own DB row still advertised it as resumable (issue #179).
 */
function isStaleUploadSession(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.status === 404) return true;
  // The API's own part route (local provider, issue #506) reports a forgotten
  // session as 409 UPLOAD_SESSION_INVALID rather than an S3-style 404.
  return err.status === 409 && errorReason(err) === REASON_UPLOAD_SESSION_INVALID;
}

/** The `details.reason` of a structured API error body, when it has one. */
function errorReason(err: ApiError): string | undefined {
  const details = (err.body as { details?: { reason?: unknown } } | undefined)?.details;
  return typeof details?.reason === 'string' ? details.reason : undefined;
}

/**
 * The part numbers of a 409 `UPLOAD_PARTS_MISSING` from `complete` (issue
 * #506), or null for any other error. The session is still valid: only those
 * parts need to be sent again.
 */
function missingPartNumbers(err: unknown): number[] | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  if (errorReason(err) !== REASON_UPLOAD_PARTS_MISSING) return null;
  const raw = (err.body as { details?: { partNumbers?: unknown } }).details?.partNumbers;
  if (!Array.isArray(raw)) return null;
  const parts = raw.filter((n): n is number => Number.isInteger(n) && n > 0);
  return parts.length > 0 ? parts : null;
}

/**
 * The API path of an absolute part URL the server returned with
 * `partUploadAuth: 'bearer'`. Only the path is kept: the request then goes to
 * this client's own configured server, so the bearer credential is never sent
 * to a host taken from a response (and a server whose `APP_URL` names a
 * different hostname than the one this CLI reaches it by still works).
 */
export function apiPathOfPartUrl(url: string): string {
  if (url.startsWith('/')) return url;
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * True when a failed `POST /upload/complete` means the multipart session is
 * unusable and the file must restart from a fresh init.
 *
 * Two response shapes are accepted so a CLI upgraded ahead of its server still
 * recovers (issue #183):
 *   - 409 Conflict — what the API returns once it maps the provider's
 *     `NoSuchUpload`/`InvalidPart` itself.
 *   - 500 carrying the provider's message — an older deployment letting the
 *     raw SDK error escape as a generic server error.
 *
 * The message test is deliberately narrow: a bare 500 is a genuine (retryable)
 * server fault and must NOT be mistaken for a dead session.
 */
function isStaleCompleteResponse(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  // A missing-parts conflict is recoverable in place; see missingPartNumbers.
  if (err.status === 409) return errorReason(err) !== REASON_UPLOAD_PARTS_MISSING;
  return STALE_SESSION_MESSAGE_RE.test(err.serverMessage);
}

/**
 * Upload one part. Transient/throttle retries (429/500/502/503/504/network) are
 * owned by ApiClient.putRaw / putPart via the shared retry + cooldown
 * machinery; here we only add part-number context to a terminal failure.
 * Returns the ETag.
 *
 * `target.auth` decides the request (issue #506): a presigned storage URL is
 * PUT with no credential; an API part URL is PUT with the bearer credential,
 * always to this client's own server.
 *
 * A dead session is translated into {@link StaleUploadSessionError} so the
 * caller can restart the upload instead of reporting a permanent per-part
 * failure.
 */
async function uploadPart(
  api: ApiClient,
  target: PartTarget,
  buffer: Buffer,
  partNumber: number,
  mimeType: string,
): Promise<string> {
  try {
    if (target.auth === 'bearer') {
      return await api.putPart(apiPathOfPartUrl(target.url), buffer);
    }
    return await api.putRaw(target.url, buffer, mimeType);
  } catch (err) {
    const msg =
      target.auth === 'bearer' && err instanceof Error ? err.message : describeStorageFailure(err);
    if (isStaleUploadSession(err)) {
      throw new StaleUploadSessionError(`part ${partNumber}`, msg);
    }
    throw new Error(`Part ${partNumber} failed: ${msg}`);
  }
}

/**
 * Render a failed presigned PUT as a message that names the right system.
 *
 * A part PUT goes DIRECTLY to S3/R2 — the MemoriaHub API is not in the path —
 * but it flows through the same ApiClient plumbing, so its failures arrived
 * labelled `API error 500: …`. That prefix sent operators debugging their
 * MemoriaHub deployment when the response actually came from the storage
 * provider (issue #179). Surface the provider's own error code where S3/R2
 * supplied one, since that is the detail that identifies the fault.
 */
function describeStorageFailure(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return err instanceof Error ? err.message : String(err);
  }
  const code = /<Code>([^<]+)<\/Code>/.exec(err.serverMessage)?.[1];
  return code
    ? `storage provider returned HTTP ${err.status} ${code}`
    : `storage provider returned HTTP ${err.status}: ${err.serverMessage}`;
}

/**
 * Fetch presigned URLs for a batch of part numbers from the server.
 */
async function fetchPartUrls(
  api: ApiClient,
  objectId: string,
  partNumbers: number[],
): Promise<Map<number, PartTarget>> {
  const resp = await api.post<PartUrlsResponse>(
    `/api/storage/objects/${objectId}/upload/part-urls`,
    { partNumbers },
  );
  const auth = resp.partUploadAuth ?? 'none';
  const map = new Map<number, PartTarget>();
  for (const { partNumber, url } of resp.presignedUrls) {
    map.set(partNumber, { url, auth });
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
 * Delegates to {@link runUploadSession}, retrying ONCE from a clean slate when
 * the storage provider reports that the multipart upload no longer exists.
 *
 * Why a retry loop lives here: `isServerSessionValid` can only ask OUR API
 * whether the upload is still live, and the API answers from its own
 * `storage_objects` row — it never asks S3/R2. When the provider has garbage-
 * collected an abandoned multipart upload (which is exactly what happens after
 * a failed part PUT strands one), the DB still advertises a resumable session
 * and every subsequent part PUT 404s with `NoSuchUpload`, forever. Detecting
 * that reactively and re-initializing is the only way the file can recover
 * without manual intervention (issue #179).
 *
 * The re-upload re-sends bytes that were already transferred. That waste is
 * bounded by a single file and is strictly better than the alternative, which
 * was losing the file permanently.
 */
export async function uploadFile(
  api: ApiClient,
  filePath: string,
  mimeType: string,
  onProgress?: (fraction: number) => void,
  persistence?: UploadPersistence,
): Promise<UploadResult> {
  try {
    return await runUploadSession(api, filePath, mimeType, onProgress, persistence);
  } catch (err) {
    if (!(err instanceof StaleUploadSessionError)) throw err;

    // Drop the dead session (clears upload_id, part_size and every persisted
    // part row) so the retry below cannot resume into it again, then run a
    // single fresh session. A second stale-session failure is a real problem
    // (e.g. a missing bucket) and propagates to the caller.
    persistence?.onComplete();
    return runUploadSession(api, filePath, mimeType, onProgress, persistence, {
      ignoreResumeState: true,
    });
  }
}

/**
 * One attempt at the resumable multipart upload flow.
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
 *
 * `opts.ignoreResumeState` forces step 1 to be skipped entirely — used by the
 * caller's stale-session retry so a known-dead session is never consulted.
 */
async function runUploadSession(
  api: ApiClient,
  filePath: string,
  mimeType: string,
  onProgress?: (fraction: number) => void,
  persistence?: UploadPersistence,
  opts?: { ignoreResumeState?: boolean },
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
  const urlCache = new Map<number, PartTarget>();
  // Merged list of ALL completed parts (resumed + newly uploaded).
  const completedParts: Array<{ partNumber: number; eTag: string }> = [];
  // Set of part numbers that were already done before this invocation.
  const resumedSet = new Set<number>();

  // ------------------------------------------------------------------
  // 1. Attempt to resume an interrupted upload
  // ------------------------------------------------------------------
  const resumeState = opts?.ignoreResumeState
    ? null
    : persistence?.getResumeState() ?? null;
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

    // Seed URL cache with the part URLs from the init response.
    const auth = init.partUploadAuth ?? 'none';
    for (const { partNumber, url } of init.presignedUrls) {
      urlCache.set(partNumber, { url, auth });
    }

    // Persist the session identifiers so a crash now still leaves enough
    // information to validate the session on the next attempt.
    persistence?.onInit(objectId, init.uploadId, partSize);
  }

  /** Read one part's slice, PUT it, and persist its ETag before returning. */
  const sendPart = async (partNumber: number, target: PartTarget): Promise<string> => {
    const start = (partNumber - 1) * partSize;
    const length = Math.min(partSize, fileSize - start);
    const buffer = await readFileSlice(filePath, start, length);

    const eTag = await uploadPart(api, target, buffer, partNumber, mimeType);

    // Persist immediately so a crash after this PUT is not wasted.
    persistence?.onPartComplete(partNumber, eTag);
    return eTag;
  };

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

    const eTag = await sendPart(partNumber, urlCache.get(partNumber)!);
    completedParts.push({ partNumber, eTag });

    if (onProgress) {
      onProgress(partNumber / totalParts);
    }
  }

  // ------------------------------------------------------------------
  // 4. Finalize the upload on the server
  // ------------------------------------------------------------------
  // The complete call is the ONLY network round-trip left when a resume state
  // already covers every part — the loop above is skipped entirely in that
  // case, so the part-PUT stale-session check never runs. Guarding here is what
  // makes a fully-resumed file recoverable rather than permanently stuck
  // (issue #183).
  //
  // A 409 UPLOAD_PARTS_MISSING (issue #506 — the local storage provider checks
  // every part's bytes at complete) keeps the session: re-send exactly the
  // listed parts with fresh URLs and complete again.
  for (let round = 0; ; round++) {
    try {
      await api.post(`/api/storage/objects/${objectId}/upload/complete`, {
        parts: completedParts,
      });
      break;
    } catch (err) {
      const missing = missingPartNumbers(err);
      if (missing && round < MAX_MISSING_PART_ROUNDS) {
        const targets = await fetchPartUrls(api, objectId, missing);
        for (const partNumber of missing) {
          const target = targets.get(partNumber);
          if (!target) throw err;
          const eTag = await sendPart(partNumber, target);
          const existing = completedParts.find((p) => p.partNumber === partNumber);
          if (existing) existing.eTag = eTag;
          else completedParts.push({ partNumber, eTag });
        }
        completedParts.sort((a, b) => a.partNumber - b.partNumber);
        continue;
      }
      if (isStaleCompleteResponse(err)) {
        throw new StaleUploadSessionError(
          'completing the upload',
          describeStorageFailure(err),
        );
      }
      throw err;
    }
  }

  // ------------------------------------------------------------------
  // 5. Clear in-progress state now that the upload is fully committed
  // ------------------------------------------------------------------
  persistence?.onComplete();

  return { objectId };
}
