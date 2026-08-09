/**
 * backup/restore-engine.ts — Restore a backup root back into a MemoriaHub
 * server (issue #321, epic #308).
 *
 * UI-free and event-emitting, like backup-engine.ts and verify.ts: this module
 * NEVER prints — commands/backup.ts and render/headless-restore.ts own every
 * byte of terminal output.
 *
 * WHAT A RESTORE IS
 * -----------------
 * A backup root holds the ORIGINAL bytes plus a per-item sidecar. Restoring
 * therefore means: re-upload the original through the normal resumable upload
 * path, register it as a MediaItem, then reapply the user-authored metadata the
 * sidecar recorded (description, favorite, capture date, manual location, tags,
 * album membership, people associations, archive state).
 *
 * Everything DERIVED is deliberately not restored — thumbnails, EXIF-extracted
 * columns, detected faces (bounding boxes / embeddings), AI tags' provenance,
 * perceptual hashes, duplicate/burst grouping. Those regenerate from the bytes
 * via the server's enrichment pipeline, which is exactly why the restore is a
 * plain upload rather than a privileged DB import.
 *
 * AUTH
 * ----
 * A restore writes media, albums, tags and people — none of which a `nod_` node
 * credential can reach (it is accepted ONLY on /api/nodes/* routes). Restore
 * therefore requires a normal user PAT/session, and refuses a node credential
 * up front rather than failing item-by-item with 401s (assertRestoreCredential).
 *
 * IDEMPOTENCE / RESUMABILITY
 * --------------------------
 * Two independent mechanisms make a restore re-runnable:
 *   1. `items.restored_media_item_id` (catalog v2) — recorded immediately after
 *      the MediaItem is created, so a crash mid-metadata still resumes. A row
 *      carrying an id is VERIFIED against the server (GET /api/media/:id) and
 *      skipped; a 404 (restored into a server that has since lost the item)
 *      clears the marker and re-uploads.
 *   2. Server-side content-hash dedup on (circle_id, content_hash) — a re-upload
 *      of the same bytes returns the existing MediaItem with
 *      `deduplicated: true`. That is a SKIP, never an error.
 *
 * SCOPE
 * -----
 * Default: `status='present'` rows — active AND archived items, since
 * `archived` is a flag on a present row (archived items are restored, then
 * re-archived at the end through PATCH /api/media/bulk/archive).
 * `--include trashed` adds `trashed` rows; they land as ACTIVE items, because
 * no public API can put an item into the server's Trash.
 * `quarantined` items are NEVER restored (the server no longer lists them —
 * restoring would resurrect deleted content), and neither are `failed` rows
 * (their local bytes are known-bad).
 */

import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type BetterSqlite3 from 'better-sqlite3';
import type {
  AlbumSummary,
  ApiClient,
  Circle,
  CreateMediaItemBody,
  MediaItemRecord,
} from '../api.js';
import { ApiError } from '../api.js';
import { runPool } from '../sync/worker-pool.js';
import { CatalogRepo, type CatalogItem, type CatalogItemStatus } from './catalog-repo.js';
import { CATALOG_DIR, absPathFor } from './layout.js';

/** Default concurrent upload workers — restore is upload-bound, keep it gentle. */
export const DEFAULT_RESTORE_CONCURRENCY = 2;

/** Max ids per PATCH /api/media/bulk call (server cap is 500; 100 keeps sets tight). */
export const BULK_UPDATE_BATCH = 100;

/** Max ids per bulk tags / album-items / bulk archive call (server cap). */
export const BULK_IDS_BATCH = 500;

export const RESTORE_EV = {
  PLAN: 'restore-plan',
  ITEM_STARTED: 'restore-item-started',
  ITEM_DONE: 'restore-item-done',
  METADATA: 'restore-metadata',
  FINISHED: 'restore-finished',
} as const;

export type RestoreEventName = (typeof RESTORE_EV)[keyof typeof RESTORE_EV];

/** Typed emitter for restore progress (renderers subscribe; engine never prints). */
export class RestoreEmitter extends EventEmitter {}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when the configured token is a `nod_` node credential. */
export class NodeCredentialNotAllowedError extends Error {
  constructor() {
    super(
      'Restore needs a normal account login — the stored token is a node ' +
        'credential (nod_…), which the server accepts ONLY on /api/nodes/* ' +
        'routes and can never use to write media, albums, tags or people. ' +
        'Run `memoriahub login` with your own account (or set MEMORIAHUB_TOKEN ' +
        'to a personal access token) and retry.',
    );
    this.name = 'NodeCredentialNotAllowedError';
  }
}

/**
 * Thrown for an unresolvable circle mapping. ALWAYS raised before the first
 * write — an unknown --map-circle/--into-circle target must not be discovered
 * halfway through an upload run.
 */
export class RestoreMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreMappingError';
  }
}

/** Reject a `nod_` node credential up front (see the auth note in the header). */
export function assertRestoreCredential(token: string): void {
  if (token.startsWith('nod_')) throw new NodeCredentialNotAllowedError();
}

// ---------------------------------------------------------------------------
// Sidecar (structural subset of the server's schemaVersion-1 document)
// ---------------------------------------------------------------------------

export interface RestoreSidecar {
  mediaItemId?: string;
  circleId?: string;
  circleName?: string | null;
  type?: string;
  originalFilename?: string;
  capturedAt?: string | null;
  capturedAtOffset?: number | null;
  mimeType?: string | null;
  description?: string | null;
  favorite?: boolean;
  archivedAt?: string | null;
  geo?: {
    takenLat?: number | null;
    takenLng?: number | null;
    takenAltitude?: number | null;
    coordSource?: string | null;
  } | null;
  tags?: Array<{ name: string; source?: string }>;
  albums?: Array<{ id: string; name: string | null }>;
  people?: Array<{ personId: string; name: string | null }>;
  sourcePath?: string | null;
  sourceDeviceId?: string | null;
  sourceDeviceName?: string | null;
  [key: string]: unknown;
}

/** One entry of catalog/albums.json (written by every completed backup run). */
interface AlbumCatalogEntry {
  id: string;
  name: string;
  description?: string | null;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type CircleResolution =
  | 'mapped'
  | 'into-circle'
  | 'matched-by-name'
  | 'create';

export interface RestoreCirclePlan {
  sourceCircleId: string;
  /** From the first sidecar of that circle; null when unreadable. */
  sourceCircleName: string | null;
  /** Null only in --dry-run for a circle that WOULD be created. */
  targetCircleId: string | null;
  targetCircleName: string;
  resolution: CircleResolution;
  items: number;
  bytes: number;
  albums: number;
  people: number;
  tags: number;
  /** Items already carrying a restored_media_item_id (skipped unless gone). */
  alreadyRestored: number;
}

export interface RestorePlan {
  dryRun: boolean;
  includeTrashed: boolean;
  skipMetadata: boolean;
  concurrency: number;
  circles: RestoreCirclePlan[];
  totalItems: number;
  totalBytes: number;
  alreadyRestored: number;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type RestoreOutcome = 'uploaded' | 'skipped-existing' | 'failed';

export interface RestoreItemResult {
  mediaItemId: string;
  relPath: string;
  outcome: RestoreOutcome;
  /** Server MediaItem id (absent only on failure). */
  restoredMediaItemId?: string;
  bytes: number;
  /** True when the skip came from server-side content-hash dedup. */
  deduplicated?: boolean;
  error?: string;
}

export interface RestoreFailure {
  /** 'item' or the metadata phase that failed ('tags', 'albums', …). */
  scope: string;
  relPath?: string;
  error: string;
}

export interface RestoreSummary {
  dryRun: boolean;
  plan: RestorePlan;
  uploaded: number;
  skippedExisting: number;
  failed: number;
  /** Items that had at least one piece of sidecar metadata reapplied. */
  metadataApplied: number;
  tagLinks: number;
  albumLinks: number;
  albumsCreated: number;
  peopleLinks: number;
  archived: number;
  circlesCreated: number;
  bytesUploaded: number;
  failures: RestoreFailure[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Options / deps
// ---------------------------------------------------------------------------

export interface RestoreOptions {
  /** Absolute backup root. */
  root: string;
  /** Compute and report the plan; write NOTHING (no circles, no uploads). */
  dryRun?: boolean;
  /** Map every source circle into this existing circle id. */
  intoCircle?: string | null;
  /** Explicit per-circle mapping: sourceCircleId -> targetCircleId. */
  mapCircle?: Map<string, string>;
  /** Also restore `trashed` catalog rows (they land ACTIVE). */
  includeTrashed?: boolean;
  concurrency?: number;
  /** Upload originals only; reapply no sidecar metadata at all. */
  skipMetadata?: boolean;
}

/** Upload one local file through the resumable path; returns the object id. */
export type RestoreUploadFn = (
  filePath: string,
  mimeType: string,
  onProgress?: (fraction: number) => void,
) => Promise<{ objectId: string }>;

/** The slice of ApiClient a restore uses — mockable wholesale in tests. */
export type RestoreApi = Pick<
  ApiClient,
  | 'listCircles'
  | 'createCircle'
  | 'getMediaItem'
  | 'createMediaItem'
  | 'bulkUpdateMedia'
  | 'bulkTags'
  | 'bulkArchiveMedia'
  | 'listAlbums'
  | 'createAlbum'
  | 'addAlbumItems'
  | 'addPersonToMedia'
>;

export interface RestoreDeps {
  db: BetterSqlite3.Database;
  api: RestoreApi;
  upload: RestoreUploadFn;
  now?: () => Date;
  isCancelled?: () => boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse repeated `--map-circle <src>=<dst>` values into a source→target map.
 * A malformed pair is a hard error (never a silently ignored mapping).
 */
export function parseMapCircle(pairs: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of pairs) {
    const idx = raw.indexOf('=');
    if (idx <= 0 || idx === raw.length - 1) {
      throw new RestoreMappingError(
        `Invalid --map-circle value "${raw}" — expected <sourceCircleId>=<targetCircleId>.`,
      );
    }
    map.set(raw.slice(0, idx).trim(), raw.slice(idx + 1).trim());
  }
  return map;
}

/** Read and parse an item's sidecar; null when missing or unparseable. */
export function readSidecar(root: string, sidecarRelPath: string): RestoreSidecar | null {
  try {
    const raw = fs.readFileSync(absPathFor(root, sidecarRelPath), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as RestoreSidecar;
  } catch {
    /* missing / unreadable / not JSON — restore falls back to catalog data */
  }
  return null;
}

/** Load catalog/albums.json (album descriptions) — best-effort, [] when absent. */
function readAlbumCatalog(root: string): Map<string, AlbumCatalogEntry> {
  const out = new Map<string, AlbumCatalogEntry>();
  try {
    const raw = fs.readFileSync(absPathFor(root, `${CATALOG_DIR}/albums.json`), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      for (const entry of parsed as AlbumCatalogEntry[]) {
        if (entry && typeof entry.id === 'string') out.set(entry.id, entry);
      }
    }
  } catch {
    /* no dimension catalog yet — album descriptions are simply not restored */
  }
  return out;
}

/** Media type for POST /api/media: the sidecar's own value, else the mime type. */
export function resolveMediaType(
  sidecar: RestoreSidecar | null,
  mimeType: string | null,
): 'photo' | 'video' {
  if (sidecar?.type === 'video' || sidecar?.type === 'photo') return sidecar.type;
  return (mimeType ?? '').startsWith('video/') ? 'video' : 'photo';
}

// ---------------------------------------------------------------------------
// Circle mapping
// ---------------------------------------------------------------------------

export interface CircleMappingInput {
  /** Distinct source circle ids in the restore set, with a display name. */
  sources: Array<{ circleId: string; circleName: string | null }>;
  intoCircle?: string | null;
  mapCircle?: Map<string, string>;
  /** When true, a circle that would be created is only PLANNED, never created. */
  dryRun: boolean;
}

export interface CircleMappingResult {
  /** sourceCircleId -> resolved target (targetCircleId null only in dry-run). */
  entries: Map<
    string,
    { targetCircleId: string | null; targetCircleName: string; resolution: CircleResolution }
  >;
  circlesCreated: number;
}

/**
 * Resolve every source circle to a target circle, in strict precedence order:
 *   1. `--map-circle <src>=<dst>`
 *   2. `--into-circle <dst>` (everything lands there)
 *   3. find-or-create by the sidecar's circleName among the caller's circles
 *      (exact name match; ambiguous duplicates resolve to the first listed).
 *
 * An unknown --map-circle / --into-circle TARGET throws RestoreMappingError —
 * validated against the caller's own circle list BEFORE any write happens.
 */
export async function resolveCircleMapping(
  api: Pick<RestoreApi, 'listCircles' | 'createCircle'>,
  input: CircleMappingInput,
): Promise<CircleMappingResult> {
  const existing: Circle[] = await api.listCircles();
  const byId = new Map(existing.map((c) => [c.id, c]));
  const byName = new Map<string, Circle>();
  for (const circle of existing) {
    if (!byName.has(circle.name)) byName.set(circle.name, circle);
  }

  // Validate every explicitly-requested target FIRST — before a single write.
  if (input.intoCircle && !byId.has(input.intoCircle)) {
    throw new RestoreMappingError(
      `--into-circle target ${input.intoCircle} is not a circle you belong to. ` +
        `Available: ${describeCircles(existing)}`,
    );
  }
  for (const [source, target] of input.mapCircle ?? []) {
    if (!byId.has(target)) {
      throw new RestoreMappingError(
        `--map-circle target ${target} (for source circle ${source}) is not a ` +
          `circle you belong to. Available: ${describeCircles(existing)}`,
      );
    }
  }

  const entries: CircleMappingResult['entries'] = new Map();
  let circlesCreated = 0;

  for (const source of input.sources) {
    const mapped = input.mapCircle?.get(source.circleId);
    if (mapped) {
      entries.set(source.circleId, {
        targetCircleId: mapped,
        targetCircleName: byId.get(mapped)?.name ?? mapped,
        resolution: 'mapped',
      });
      continue;
    }

    if (input.intoCircle) {
      entries.set(source.circleId, {
        targetCircleId: input.intoCircle,
        targetCircleName: byId.get(input.intoCircle)?.name ?? input.intoCircle,
        resolution: 'into-circle',
      });
      continue;
    }

    const name = source.circleName?.trim();
    if (!name) {
      throw new RestoreMappingError(
        `Source circle ${source.circleId} has no recorded circle name in its ` +
          'sidecars, so it cannot be matched or created by name. Pass ' +
          `--map-circle ${source.circleId}=<targetCircleId> or --into-circle <id>.`,
      );
    }

    const match = byName.get(name);
    if (match) {
      entries.set(source.circleId, {
        targetCircleId: match.id,
        targetCircleName: match.name,
        resolution: 'matched-by-name',
      });
      continue;
    }

    if (input.dryRun) {
      entries.set(source.circleId, {
        targetCircleId: null,
        targetCircleName: name,
        resolution: 'create',
      });
      continue;
    }

    const created = await api.createCircle({ name });
    circlesCreated++;
    byId.set(created.id, created);
    byName.set(created.name, created);
    entries.set(source.circleId, {
      targetCircleId: created.id,
      targetCircleName: created.name,
      resolution: 'create',
    });
  }

  return { entries, circlesCreated };
}

function describeCircles(circles: Circle[]): string {
  if (circles.length === 0) return '(none)';
  return circles
    .slice(0, 10)
    .map((c) => `${c.name} (${c.id})`)
    .join(', ');
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface BulkSet {
  location?: { lat: number; lng: number; altitude?: number };
  favorite?: boolean;
  capturedAt?: string;
}

interface UpdateBatch {
  circleId: string;
  set: BulkSet;
  ids: string[];
}

interface TagBatch {
  circleId: string;
  tags: string[];
  ids: string[];
}

interface AlbumBatch {
  circleId: string;
  albumName: string;
  albumDescription?: string;
  ids: string[];
}

/**
 * Run one restore pass. Never throws for a per-item failure (those land in the
 * summary); throws only for a pre-flight condition that makes the whole run
 * meaningless — RestoreMappingError, or an API failure while listing circles.
 */
export async function runRestore(
  opts: RestoreOptions,
  deps: RestoreDeps,
  emitter: RestoreEmitter = new RestoreEmitter(),
): Promise<RestoreSummary> {
  const now = deps.now ?? ((): Date => new Date());
  const startedAt = now().getTime();
  const dryRun = opts.dryRun === true;
  const skipMetadata = opts.skipMetadata === true;
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? DEFAULT_RESTORE_CONCURRENCY));

  const repo = new CatalogRepo(deps.db);
  const statuses: CatalogItemStatus[] = opts.includeTrashed
    ? ['present', 'trashed']
    : ['present'];

  const items = repo.listForRestore(statuses);
  const dims = repo.restoreDimensionCounts(statuses);
  const albumCatalog = readAlbumCatalog(opts.root);

  // ---- Plan -----------------------------------------------------------------
  const perCircle = new Map<
    string,
    { items: number; bytes: number; alreadyRestored: number; name: string | null }
  >();
  for (const item of items) {
    const entry = perCircle.get(item.circleId) ?? {
      items: 0,
      bytes: 0,
      alreadyRestored: 0,
      name: null,
    };
    entry.items++;
    entry.bytes += item.size ?? 0;
    if (item.restoredMediaItemId) entry.alreadyRestored++;
    if (entry.name === null) {
      // One sidecar read per circle is enough to learn its name — the plan must
      // not load every sidecar into memory on a 100k-item root.
      entry.name = readSidecar(opts.root, item.sidecarRelPath)?.circleName ?? null;
    }
    perCircle.set(item.circleId, entry);
  }

  const mapping = await resolveCircleMapping(deps.api, {
    sources: [...perCircle].map(([circleId, e]) => ({ circleId, circleName: e.name })),
    ...(opts.intoCircle !== undefined ? { intoCircle: opts.intoCircle } : {}),
    ...(opts.mapCircle !== undefined ? { mapCircle: opts.mapCircle } : {}),
    dryRun,
  });

  const circlePlans: RestoreCirclePlan[] = [...perCircle].map(([circleId, e]) => {
    const target = mapping.entries.get(circleId)!;
    const dim = dims.get(circleId) ?? { albums: 0, people: 0, tags: 0 };
    return {
      sourceCircleId: circleId,
      sourceCircleName: e.name,
      targetCircleId: target.targetCircleId,
      targetCircleName: target.targetCircleName,
      resolution: target.resolution,
      items: e.items,
      bytes: e.bytes,
      albums: dim.albums,
      people: dim.people,
      tags: dim.tags,
      alreadyRestored: e.alreadyRestored,
    };
  });

  const plan: RestorePlan = {
    dryRun,
    includeTrashed: opts.includeTrashed === true,
    skipMetadata,
    concurrency,
    circles: circlePlans,
    totalItems: items.length,
    totalBytes: circlePlans.reduce((sum, c) => sum + c.bytes, 0),
    alreadyRestored: circlePlans.reduce((sum, c) => sum + c.alreadyRestored, 0),
  };
  emitter.emit(RESTORE_EV.PLAN, plan);

  const summary: RestoreSummary = {
    dryRun,
    plan,
    uploaded: 0,
    skippedExisting: 0,
    failed: 0,
    metadataApplied: 0,
    tagLinks: 0,
    albumLinks: 0,
    albumsCreated: 0,
    peopleLinks: 0,
    archived: 0,
    circlesCreated: mapping.circlesCreated,
    bytesUploaded: 0,
    failures: [],
    durationMs: 0,
  };

  if (dryRun) {
    summary.durationMs = now().getTime() - startedAt;
    emitter.emit(RESTORE_EV.FINISHED, { summary });
    return summary;
  }

  // ---- Batch state ----------------------------------------------------------
  const updateBatches = new Map<string, UpdateBatch>();
  const tagBatches = new Map<string, TagBatch>();
  const albumBatches = new Map<string, AlbumBatch>();
  const archiveBatches = new Map<string, string[]>();
  /** circleId -> (albumName -> albumId), lazily filled from the server. */
  const albumIdCache = new Map<string, Map<string, string>>();

  const recordFailure = (scope: string, relPath: string | undefined, err: unknown): void => {
    summary.failures.push({
      scope,
      ...(relPath !== undefined ? { relPath } : {}),
      error: err instanceof Error ? err.message : String(err),
    });
  };

  async function resolveAlbumId(
    circleId: string,
    name: string,
    description?: string,
  ): Promise<string> {
    let cache = albumIdCache.get(circleId);
    if (!cache) {
      cache = new Map();
      // Page through the circle's albums once; names are display-only and not
      // unique server-side, so the FIRST match wins (stable and deterministic).
      for (let page = 1; page <= 50; page++) {
        const albums: AlbumSummary[] = await deps.api.listAlbums(circleId, page, 100);
        for (const album of albums) {
          if (!cache.has(album.name)) cache.set(album.name, album.id);
        }
        if (albums.length < 100) break;
      }
      albumIdCache.set(circleId, cache);
    }

    const hit = cache.get(name);
    if (hit) return hit;

    const created = await deps.api.createAlbum({
      circleId,
      name,
      ...(description ? { description } : {}),
    });
    cache.set(name, created.id);
    summary.albumsCreated++;
    return created.id;
  }

  async function flushUpdate(batch: UpdateBatch, all: boolean): Promise<void> {
    while (batch.ids.length >= (all ? 1 : BULK_UPDATE_BATCH)) {
      const ids = batch.ids.splice(0, BULK_UPDATE_BATCH);
      try {
        await deps.api.bulkUpdateMedia({ circleId: batch.circleId, ids, set: batch.set });
        emitter.emit(RESTORE_EV.METADATA, { kind: 'update', applied: ids.length });
      } catch (err) {
        recordFailure('metadata:update', undefined, err);
      }
    }
  }

  async function flushTags(batch: TagBatch, all: boolean): Promise<void> {
    while (batch.ids.length >= (all ? 1 : BULK_IDS_BATCH)) {
      const ids = batch.ids.splice(0, BULK_IDS_BATCH);
      try {
        await deps.api.bulkTags({ circleId: batch.circleId, ids, add: batch.tags });
        summary.tagLinks += ids.length * batch.tags.length;
        emitter.emit(RESTORE_EV.METADATA, { kind: 'tags', applied: ids.length });
      } catch (err) {
        recordFailure('metadata:tags', undefined, err);
      }
    }
  }

  async function flushAlbum(batch: AlbumBatch, all: boolean): Promise<void> {
    while (batch.ids.length >= (all ? 1 : BULK_IDS_BATCH)) {
      const ids = batch.ids.splice(0, BULK_IDS_BATCH);
      try {
        const albumId = await resolveAlbumId(
          batch.circleId,
          batch.albumName,
          batch.albumDescription,
        );
        await deps.api.addAlbumItems(albumId, ids);
        summary.albumLinks += ids.length;
        emitter.emit(RESTORE_EV.METADATA, { kind: 'albums', applied: ids.length });
      } catch (err) {
        recordFailure('metadata:albums', undefined, err);
      }
    }
  }

  async function flushArchive(circleId: string, ids: string[], all: boolean): Promise<void> {
    while (ids.length >= (all ? 1 : BULK_IDS_BATCH)) {
      const chunk = ids.splice(0, BULK_IDS_BATCH);
      try {
        await deps.api.bulkArchiveMedia({ circleId, ids: chunk });
        summary.archived += chunk.length;
        emitter.emit(RESTORE_EV.METADATA, { kind: 'archive', applied: chunk.length });
      } catch (err) {
        recordFailure('metadata:archive', undefined, err);
      }
    }
  }

  /**
   * Queue (and opportunistically flush) every batched metadata write implied by
   * one restored item, and apply the unbatchable ones (people) inline.
   */
  async function applyMetadata(
    sidecar: RestoreSidecar,
    created: MediaItemRecord,
    circleId: string,
    relPath: string,
    catalogTags: string[],
  ): Promise<boolean> {
    let applied = false;

    // --- favorite / capturedAt / manual location (PATCH /api/media/bulk) ---
    const set: BulkSet = {};
    if (sidecar.favorite === true && created.favorite !== true) set.favorite = true;
    // Only patch the capture date when the upload did not already land on it —
    // a server-extracted EXIF date is authoritative and identical anyway.
    if (
      typeof sidecar.capturedAt === 'string' &&
      normalizeInstant(created.capturedAt) !== normalizeInstant(sidecar.capturedAt)
    ) {
      set.capturedAt = sidecar.capturedAt;
    }
    const geo = sidecar.geo;
    if (
      geo?.coordSource === 'manual' &&
      typeof geo.takenLat === 'number' &&
      typeof geo.takenLng === 'number'
    ) {
      set.location = {
        lat: geo.takenLat,
        lng: geo.takenLng,
        ...(typeof geo.takenAltitude === 'number' ? { altitude: geo.takenAltitude } : {}),
      };
    }
    if (Object.keys(set).length > 0) {
      const key = `${circleId}|${JSON.stringify(set)}`;
      const batch = updateBatches.get(key) ?? { circleId, set, ids: [] };
      batch.ids.push(created.id);
      updateBatches.set(key, batch);
      applied = true;
      await flushUpdate(batch, false);
    }

    // --- tags (POST /api/media/bulk/tags; ALL sidecar tags, any source) ---
    const tags = (
      sidecar.tags?.map((t) => t.name).filter((n): n is string => typeof n === 'string' && n.length > 0) ??
      catalogTags
    )
      .slice()
      .sort();
    if (tags.length > 0) {
      // Grouped by identical tag SET: bulk tags applies one add[] to many ids,
      // so items sharing a tag set collapse into a single call.
      const key = `${circleId}|${tags.join(' ')}`;
      const batch = tagBatches.get(key) ?? { circleId, tags, ids: [] };
      batch.ids.push(created.id);
      tagBatches.set(key, batch);
      applied = true;
      await flushTags(batch, false);
    }

    // --- albums (find-or-create by NAME, then add items) ---
    for (const album of sidecar.albums ?? []) {
      const name = album.name?.trim();
      if (!name) continue;
      const key = `${circleId}|${name}`;
      const description = albumCatalog.get(album.id)?.description ?? undefined;
      const batch = albumBatches.get(key) ?? {
        circleId,
        albumName: name,
        ...(description ? { albumDescription: description } : {}),
        ids: [],
      };
      batch.ids.push(created.id);
      albumBatches.set(key, batch);
      applied = true;
      await flushAlbum(batch, false);
    }

    // --- people (per item; find-or-create by name, idempotent server-side) ---
    for (const person of sidecar.people ?? []) {
      const name = person.name?.trim();
      if (!name) continue;
      try {
        await deps.api.addPersonToMedia(created.id, { name });
        summary.peopleLinks++;
        applied = true;
      } catch (err) {
        recordFailure('metadata:people', relPath, err);
      }
    }

    // --- archive state (applied at the very end, after everything else) ---
    if (typeof sidecar.archivedAt === 'string' && sidecar.archivedAt.length > 0) {
      const ids = archiveBatches.get(circleId) ?? [];
      ids.push(created.id);
      archiveBatches.set(circleId, ids);
      applied = true;
    }

    return applied;
  }

  // ---- Per-item worker ------------------------------------------------------
  async function restoreItem(item: CatalogItem): Promise<void> {
    const target = mapping.entries.get(item.circleId);
    const circleId = target?.targetCircleId;
    emitter.emit(RESTORE_EV.ITEM_STARTED, {
      mediaItemId: item.mediaItemId,
      relPath: item.relPath,
    });

    const finish = (result: RestoreItemResult): void => {
      if (result.outcome === 'uploaded') {
        summary.uploaded++;
        summary.bytesUploaded += result.bytes;
      } else if (result.outcome === 'skipped-existing') {
        summary.skippedExisting++;
      } else {
        summary.failed++;
        recordFailure('item', result.relPath, result.error ?? 'unknown error');
      }
      emitter.emit(RESTORE_EV.ITEM_DONE, result);
    };

    if (!circleId) {
      finish({
        mediaItemId: item.mediaItemId,
        relPath: item.relPath,
        outcome: 'failed',
        bytes: 0,
        error: `No target circle resolved for source circle ${item.circleId}`,
      });
      return;
    }

    try {
      // 1. Already restored? Verify server-side, then skip.
      if (item.restoredMediaItemId) {
        const stillThere = await mediaItemExists(deps.api, item.restoredMediaItemId);
        if (stillThere) {
          finish({
            mediaItemId: item.mediaItemId,
            relPath: item.relPath,
            outcome: 'skipped-existing',
            restoredMediaItemId: item.restoredMediaItemId,
            bytes: 0,
          });
          return;
        }
        // The server no longer has it — drop the stale marker and re-upload.
        repo.setRestoredMediaItemId(item.mediaItemId, null);
      }

      const absPath = absPathFor(opts.root, item.relPath);
      if (!fs.existsSync(absPath)) {
        finish({
          mediaItemId: item.mediaItemId,
          relPath: item.relPath,
          outcome: 'failed',
          bytes: 0,
          error: 'local file is missing from the backup root',
        });
        return;
      }

      const sidecar = readSidecar(opts.root, item.sidecarRelPath);
      const mimeType = item.mimeType ?? sidecar?.mimeType ?? 'application/octet-stream';

      // 2. Upload the original bytes (resumable multipart, same path as sync).
      const { objectId } = await deps.upload(absPath, mimeType);

      // 3. Register the MediaItem. contentHash drives server-side dedup, which
      //    is what makes a re-run of an interrupted restore idempotent.
      const body: CreateMediaItemBody = {
        storageObjectId: objectId,
        type: resolveMediaType(sidecar, item.mimeType),
        source: 'cli',
        originalFilename:
          sidecar?.originalFilename ?? item.relPath.split('/').pop() ?? 'restored-file',
        circleId,
        ...(item.contentHash ? { contentHash: item.contentHash } : {}),
      };
      if (!skipMetadata && sidecar) {
        if (typeof sidecar.capturedAt === 'string') body.capturedAt = sidecar.capturedAt;
        if (typeof sidecar.capturedAtOffset === 'number') {
          body.capturedAtOffset = sidecar.capturedAtOffset;
        }
        // description has no bulk endpoint, so it rides along on creation.
        if (typeof sidecar.description === 'string' && sidecar.description.length > 0) {
          body.description = sidecar.description;
        }
        if (sidecar.favorite === true) body.favorite = true;
        if (typeof sidecar.sourcePath === 'string') body.sourcePath = sidecar.sourcePath;
        if (typeof sidecar.sourceDeviceId === 'string') {
          body.sourceDeviceId = sidecar.sourceDeviceId;
        }
        if (typeof sidecar.sourceDeviceName === 'string') {
          body.sourceDeviceName = sidecar.sourceDeviceName;
        }
      }

      const created = await deps.api.createMediaItem(body);
      repo.setRestoredMediaItemId(item.mediaItemId, created.id);

      // 4. Reapply the sidecar metadata (batched where the API allows it).
      if (!skipMetadata && sidecar) {
        const applied = await applyMetadata(
          sidecar,
          created,
          circleId,
          item.relPath,
          repo.tagsFor(item.mediaItemId),
        );
        if (applied) summary.metadataApplied++;
      }

      finish({
        mediaItemId: item.mediaItemId,
        relPath: item.relPath,
        outcome: created.deduplicated === true ? 'skipped-existing' : 'uploaded',
        restoredMediaItemId: created.id,
        bytes: created.deduplicated === true ? 0 : item.size ?? 0,
        ...(created.deduplicated === true ? { deduplicated: true } : {}),
      });
    } catch (err) {
      finish({
        mediaItemId: item.mediaItemId,
        relPath: item.relPath,
        outcome: 'failed',
        bytes: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await runPool(items, concurrency, (item) => restoreItem(item), deps.isCancelled);

  // ---- Drain every partially-filled batch -----------------------------------
  for (const batch of updateBatches.values()) await flushUpdate(batch, true);
  for (const batch of tagBatches.values()) await flushTags(batch, true);
  for (const batch of albumBatches.values()) await flushAlbum(batch, true);
  // Archive last: an item must exist (and carry its metadata) before it is
  // hidden from every browse surface.
  for (const [circleId, ids] of archiveBatches) await flushArchive(circleId, ids, true);

  summary.durationMs = now().getTime() - startedAt;
  emitter.emit(RESTORE_EV.FINISHED, { summary });
  return summary;
}

/** True when GET /api/media/:id answers 200; false on 404. Other errors throw. */
async function mediaItemExists(api: RestoreApi, id: string): Promise<boolean> {
  try {
    await api.getMediaItem(id);
    return true;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) return false;
    throw err;
  }
}

/** Compare two ISO instants for equality without tripping over formatting. */
function normalizeInstant(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

/** Exit-code policy for `backup restore`: any failure is non-zero. */
export function resolveRestoreExitCode(summary: RestoreSummary): number {
  return summary.failed > 0 || summary.failures.length > 0 ? 1 : 0;
}
