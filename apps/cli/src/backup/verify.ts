/**
 * backup/verify.ts — Local integrity verification of a backup root
 * (issue #320, epic #308).
 *
 * UI-free and event-emitting, like the backup engine: `memoriahub backup
 * verify` renders; this module never prints.
 *
 * Two modes, both driven off the catalog rather than a filesystem walk (the
 * catalog is the source of truth for what SHOULD be present):
 *
 *   default  — existence + size for EVERY 'present' row, plus a full sha256
 *              for the rows whose bytes have not been proven since they
 *              landed: downloaded_at > verified_at, verified_at IS NULL, or
 *              status='failed'. This is the cheap everyday check: a
 *              multi-TB root is stat()ed, and only the genuinely unproven
 *              tail is hashed.
 *   --deep   — sha256 EVERY file. Streamed (never buffered) with a bounded
 *              worker pool (--concurrency, default 4). No bandwidth cap:
 *              this is local disk, and the TokenBucket exists to protect a
 *              network link, not an SSD.
 *
 * Outcome policy mirrors reconcile's drift handling, so the two features heal
 * through the SAME path: a missing file or a hash mismatch sets
 * status='failed' and clears verified_at, which makes the next incremental
 * run re-download the bytes (the engine re-downloads 'failed' rows). A file
 * that verifies gets verified_at = now and is healed back to 'present'.
 * Nothing is ever deleted or moved by verify.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type BetterSqlite3 from 'better-sqlite3';
import { runPool } from '../sync/worker-pool.js';
import { CatalogRepo, type CatalogItem } from './catalog-repo.js';
import { absPathFor } from './layout.js';

/** Default hashing concurrency (local disk — no bandwidth cap applies). */
export const DEFAULT_VERIFY_CONCURRENCY = 4;

export const VERIFY_EV = {
  STARTED: 'verify-started',
  ITEM_DONE: 'verify-item-done',
  FINISHED: 'verify-finished',
} as const;

export type VerifyEventName = (typeof VERIFY_EV)[keyof typeof VERIFY_EV];

/** What happened to one item during a verify pass. */
export type VerifyOutcome =
  | 'ok'
  | 'hashed-ok'
  | 'missing'
  | 'size-mismatch'
  | 'hash-mismatch'
  | 'unreadable';

/** Outcomes that mean the local bytes are wrong and must be re-downloaded. */
const FAILING_OUTCOMES = new Set<VerifyOutcome>([
  'missing',
  'size-mismatch',
  'hash-mismatch',
  'unreadable',
]);

export function isVerifyFailure(outcome: VerifyOutcome): boolean {
  return FAILING_OUTCOMES.has(outcome);
}

export interface VerifyItemResult {
  mediaItemId: string;
  relPath: string;
  outcome: VerifyOutcome;
  /** Whether this item's bytes were fully hashed in this pass. */
  hashed: boolean;
  bytes: number;
  error?: string;
}

export interface VerifyStartedPayload {
  /** Rows selected for verification. */
  total: number;
  deep: boolean;
  concurrency: number;
}

export interface VerifyFinishedPayload {
  summary: VerifySummary;
}

export interface VerifySummary {
  checked: number;
  hashed: number;
  ok: number;
  failed: number;
  bytesHashed: number;
  /** Failing items, for the command layer's report. */
  failures: VerifyItemResult[];
  deep: boolean;
  durationMs: number;
}

export interface VerifyOptions {
  root: string;
  /** Hash EVERY file rather than only the unproven ones. */
  deep?: boolean;
  concurrency?: number;
}

export interface VerifyDeps {
  db: BetterSqlite3.Database;
  now?: () => Date;
  isCancelled?: () => boolean;
}

/** Typed emitter for verify progress (renderers subscribe; engine never prints). */
export class VerifyEmitter extends EventEmitter {}

/** Stream a file into a sha256 digest without ever buffering it whole. */
export function hashFile(absPath: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    const stream = fs.createReadStream(absPath);
    stream.on('data', (chunk) => {
      const buf = chunk as Buffer;
      bytes += buf.length;
      hash.update(buf);
    });
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), bytes }));
    stream.on('error', reject);
  });
}

/**
 * Should this row's bytes be fully hashed in a NON-deep pass? True when the
 * bytes have never been proven, or were re-downloaded since the last proof.
 */
export function needsHash(item: CatalogItem): boolean {
  if (item.status === 'failed') return true;
  if (item.verifiedAt === null) return true;
  if (item.downloadedAt === null) return false;
  const downloaded = Date.parse(item.downloadedAt);
  const verified = Date.parse(item.verifiedAt);
  if (!Number.isFinite(downloaded) || !Number.isFinite(verified)) return true;
  return downloaded > verified;
}

/**
 * Rows a verify pass covers: every 'present' row (existence + size) plus
 * every 'failed' row (they are re-checked so a transient failure that has
 * since healed on disk is credited rather than re-downloaded forever).
 * Quarantined and trashed rows are deliberately excluded — quarantine is
 * prune's territory, and a trashed row's file is a deliberate local copy of
 * something the server no longer serves.
 */
export function selectVerifyTargets(repo: CatalogRepo): CatalogItem[] {
  return [...repo.listByStatus('present'), ...repo.listByStatus('failed')].sort((a, b) =>
    a.mediaItemId < b.mediaItemId ? -1 : a.mediaItemId > b.mediaItemId ? 1 : 0,
  );
}

/** Verify ONE item against the filesystem (pure I/O; no catalog writes). */
export async function verifyItem(
  root: string,
  item: CatalogItem,
  deep: boolean,
): Promise<VerifyItemResult> {
  const abs = absPathFor(root, item.relPath);
  const base = { mediaItemId: item.mediaItemId, relPath: item.relPath };

  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return { ...base, outcome: 'missing', hashed: false, bytes: 0, error: 'file is missing' };
  }
  if (!st.isFile()) {
    return { ...base, outcome: 'missing', hashed: false, bytes: 0, error: 'path is not a file' };
  }
  if (item.size !== null && st.size !== item.size) {
    return {
      ...base,
      outcome: 'size-mismatch',
      hashed: false,
      bytes: st.size,
      error: `size ${st.size} does not match the catalog's ${item.size}`,
    };
  }

  if (!deep && !needsHash(item)) {
    return { ...base, outcome: 'ok', hashed: false, bytes: st.size };
  }

  // A row with no recorded contentHash (e.g. a server item that never
  // exposed one) can only be size-checked — hashing proves nothing.
  if (item.contentHash === null) {
    return { ...base, outcome: 'ok', hashed: false, bytes: st.size };
  }

  let digest: string;
  let bytes: number;
  try {
    const res = await hashFile(abs);
    digest = res.sha256;
    bytes = res.bytes;
  } catch (err) {
    return {
      ...base,
      outcome: 'unreadable',
      hashed: false,
      bytes: 0,
      error: `could not read the file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (digest.toLowerCase() !== item.contentHash.toLowerCase()) {
    return {
      ...base,
      outcome: 'hash-mismatch',
      hashed: true,
      bytes,
      error: `sha256 ${digest.slice(0, 12)}… does not match the catalog's ${item.contentHash.slice(0, 12)}…`,
    };
  }
  return { ...base, outcome: 'hashed-ok', hashed: true, bytes };
}

/**
 * Run a full verify pass over the catalog, writing the outcome of each item
 * back to the catalog (verified_at on success; status='failed' +
 * verified_at cleared + last_error on failure) and emitting progress.
 */
export async function runVerify(
  opts: VerifyOptions,
  deps: VerifyDeps,
  emitter?: VerifyEmitter,
): Promise<VerifySummary> {
  const now = deps.now ?? ((): Date => new Date());
  const isCancelled = deps.isCancelled ?? ((): boolean => false);
  const repo = new CatalogRepo(deps.db);
  const deep = opts.deep === true;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_VERIFY_CONCURRENCY));

  const targets = selectVerifyTargets(repo);
  const startMs = now().getTime();
  emitter?.emit(VERIFY_EV.STARTED, {
    total: targets.length,
    deep,
    concurrency,
  } satisfies VerifyStartedPayload);

  const summary: VerifySummary = {
    checked: 0,
    hashed: 0,
    ok: 0,
    failed: 0,
    bytesHashed: 0,
    failures: [],
    deep,
    durationMs: 0,
  };

  await runPool(
    targets,
    concurrency,
    async (item) => {
      const result = await verifyItem(opts.root, item, deep);

      summary.checked++;
      if (result.hashed) {
        summary.hashed++;
        summary.bytesHashed += result.bytes;
      }
      if (isVerifyFailure(result.outcome)) {
        summary.failed++;
        summary.failures.push(result);
        repo.markVerifyFailed(
          item.mediaItemId,
          `verify at ${now().toISOString()}: ${result.error ?? result.outcome}`,
        );
      } else {
        summary.ok++;
        // Only a full hash (or a deep pass) proves the bytes; a cheap
        // existence+size check must not stamp verified_at, or the next
        // default pass would skip hashing a row it never actually proved.
        if (result.hashed) repo.markVerified(item.mediaItemId, now().toISOString());
      }

      emitter?.emit(VERIFY_EV.ITEM_DONE, result);
    },
    () => isCancelled(),
  );

  summary.durationMs = now().getTime() - startMs;
  emitter?.emit(VERIFY_EV.FINISHED, { summary } satisfies VerifyFinishedPayload);
  return summary;
}

/** Exit-code policy for `backup verify`: any failing item is non-zero. */
export function resolveVerifyExitCode(summary: VerifySummary): number {
  return summary.failed > 0 ? 1 : 0;
}
