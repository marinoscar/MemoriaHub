// =============================================================================
// Memories — shared curation engine (epic #300, issue #303)
// =============================================================================
//
// The one place that answers "given a slice of a circle's library, which items
// belong in a memory, in what order, and how do I write that down without
// creating duplicates or resurrecting something the user deleted?"
//
// Every curator — On This Day here, Trips (#304), People/Theme/Seasonal/
// Year-in-Review (#305) — funnels through `curate()` and `upsertMemory()`.
// Nothing type-specific lives in this file; a curator contributes only the
// Prisma `where` that selects its slice and the identity/title it wants written.
//
// FOUR PROPERTIES THIS FILE IS RESPONSIBLE FOR
// --------------------------------------------
//
// 1. THE BASE FILTER IS NOT OPTIONAL. `memoryCandidateBaseWhere()` is applied by
//    `loadCandidates()` itself, not by callers, so a curator physically cannot
//    forget it. Archived, trashed, social-media and NULL-`capturedAt` items are
//    excluded structurally rather than by convention. (`capturedAt` is nullable
//    in this schema — an import with no EXIF date is common — and every memory
//    is time-anchored, so a NULL date is not "unknown time", it is "not a
//    candidate".)
//
// 2. MEMORY SAFETY AT LIBRARY SCALE. The target deployment is ~70k photos /
//    ~8k videos in one circle. Candidates are streamed with constant-memory
//    keyset pagination (the `workflow_evaluate` precedent) and enriched in
//    per-page batches — never one query per item, never the whole library
//    resident. A hard `maxCandidates` cap bounds the resident array even if a
//    future curator hands us a pathologically wide slice.
//
// 3. THE TOMBSTONE CONTRACT IS ABSOLUTE. `upsertMemory()` reads the existing row
//    FIRST and returns untouched if `deletedAt` is set. A user-deleted memory is
//    never recreated, never refreshed, never re-titled — the `@@unique` key
//    spans live and tombstoned rows precisely so the slot stays occupied
//    forever. See docs/specs/memories.md §2.5.
//
// 4. REFRESH DOES NOT CHURN. A memory whose membership barely moved keeps its
//    title/subtitle/narrative — including an AI-written one from #306. Only a
//    material change (Jaccard distance >= 30% on the media-item id set) resets
//    titling. Without this, every generation run would discard and re-pay for
//    AI titles because one photo joined.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';
import { MediaTagSource, MediaType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CuratedItem,
  CuratedSelection,
  MemoryCandidate,
  ScoredCandidate,
  UpsertMemoryInput,
  UpsertMemoryResult,
} from './memory-curation.types';

// --- Scoring weights (epic #300 / issue #303) --------------------------------

/** A user-marked favorite is the strongest signal the library has. */
export const FAVORITE_BONUS = 3.0;
/** A face belonging to a Person the user marked favorite. */
export const FAVORITE_PERSON_BONUS = 1.0;
/** Evidence auto-tagging actually found content (description or >= 1 AI tag). */
export const AI_CONTENT_BONUS = 0.25;
/** Variance-of-Laplacian value that maps to a full 1.0 sharpness contribution. */
export const SHARPNESS_FULL_SCALE = 1000;
/**
 * Sharpness stand-in for an item that was never scored (video, pre-feature
 * import, failed processing). Neutral 0.5 rather than 0: a missing measurement
 * is not evidence of a blurry photo, and scoring it as one would push every
 * un-analyzed item out of every memory.
 */
export const NEUTRAL_SHARPNESS = 0.5;

// --- Video policy ------------------------------------------------------------

/** Hard cap on videos in one memory — a memory is a photo story with punctuation. */
export const MAX_VIDEOS_PER_MEMORY = 3;
/** Videos at or under this length are preferred; longer ones are penalized. */
export const PREFERRED_VIDEO_MAX_MS = 60_000;
/**
 * Selection-time penalty for a long (or unknown-duration) video. Applied to
 * `selectionScore` only — the persisted `MemoryItem.score` stays the pure
 * quality score, so the penalty never masquerades as "this clip is bad".
 */
export const LONG_VIDEO_PENALTY = 0.5;

// --- Streaming / batching ----------------------------------------------------

/** Rows per keyset page while streaming candidates. */
export const CANDIDATE_PAGE_SIZE = 500;
/**
 * Hard ceiling on resident candidates for one curation pass. At ~200 bytes per
 * `MemoryCandidate` this is a few megabytes — deliberately generous, because a
 * cap that bites introduces selection bias (we would silently curate only the
 * chronologically earliest slice). It exists as a crash guard, not a tuning
 * knob; a curator that routinely hits it is asking the wrong question.
 */
export const DEFAULT_MAX_CANDIDATES = 20_000;
/** Chunk size for `id IN (...)` lookups so a wide page never builds a huge query. */
const IN_CHUNK = 1_000;

// --- Refresh policy ----------------------------------------------------------

/**
 * Jaccard DISTANCE at or above which a refresh counts as material: the titles
 * are reset to templates and `materiallyChanged` is reported to callers.
 */
export const MATERIAL_CHANGE_THRESHOLD = 0.3;

/**
 * Stamped into every memory's `meta.generatorVersion`. Bump when the scoring or
 * selection algorithm changes in a way that would produce a different item set
 * from identical inputs — it is the only way to tell, after the fact, which
 * algorithm produced a given memory.
 */
export const MEMORY_GENERATOR_VERSION = 1;

/** Exactly the columns `loadCandidates` selects while streaming candidates. */
interface CandidateRow {
  id: string;
  capturedAt: Date | null;
  type: MediaType;
  durationMs: number | null;
  favorite: boolean;
  sharpnessScore: number | null;
  burstGroupId: string | null;
  duplicateGroupId: string | null;
  description: string | null;
}

/** Options accepted by `loadCandidates` / `curate`. */
export interface CurateOptions {
  /** Hard cap on items in the produced memory (`memories.maxItemsPerMemory`). */
  maxItems: number;
  /** Override the resident-candidate ceiling. Defaults to DEFAULT_MAX_CANDIDATES. */
  maxCandidates?: number;
}

/**
 * THE curation base filter, in one expression. Applied by `loadCandidates` to
 * every curator's slice — see this file's header, property 1.
 */
export function memoryCandidateBaseWhere(circleId: string): Prisma.MediaItemWhereInput {
  return {
    circleId,
    capturedAt: { not: null },
    deletedAt: null,
    archivedAt: null,
    socialMediaSource: null,
  };
}

/** The epic's quality formula. Pure — exported for direct unit testing. */
export function scoreCandidate(candidate: MemoryCandidate): number {
  let score = 0;
  if (candidate.favorite) score += FAVORITE_BONUS;

  // Clamp into [0,1]: sharpness is an unbounded variance, and an unusually
  // crisp macro shot must not out-vote a favorite.
  const sharpness =
    candidate.sharpnessScore == null
      ? NEUTRAL_SHARPNESS
      : Math.min(Math.max(candidate.sharpnessScore / SHARPNESS_FULL_SCALE, 0), 1);
  score += sharpness;

  if (candidate.hasFavoritePersonFace) score += FAVORITE_PERSON_BONUS;
  if (candidate.hasAiContent) score += AI_CONTENT_BONUS;
  return score;
}

/** True for a video that is long, or whose duration we simply do not know. */
export function isLongVideo(candidate: MemoryCandidate): boolean {
  return (
    candidate.type === MediaType.video &&
    (candidate.durationMs == null || candidate.durationMs > PREFERRED_VIDEO_MAX_MS)
  );
}

/** Attach `score` and `selectionScore`. Pure — exported for unit testing. */
export function scoreCandidates(candidates: MemoryCandidate[]): ScoredCandidate[] {
  return candidates.map((c) => {
    const score = scoreCandidate(c);
    return {
      ...c,
      score,
      selectionScore: isLongVideo(c) ? score - LONG_VIDEO_PENALTY : score,
    };
  });
}

/**
 * Ranking order for selection: best first, ties broken deterministically so two
 * runs over an unchanged library produce byte-identical memories (which is what
 * makes "re-running changes nothing" testable rather than approximately true).
 */
function compareForSelection(a: ScoredCandidate, b: ScoredCandidate): number {
  if (b.selectionScore !== a.selectionScore) return b.selectionScore - a.selectionScore;
  const at = a.capturedAt.getTime();
  const bt = b.capturedAt.getTime();
  if (at !== bt) return at - bt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The collapse bucket an item belongs to.
 *
 * BURST WINS OVER DUPLICATE when an item somehow carries both group ids. That
 * is not an arbitrary tie-break: it mirrors the app-wide rule already enforced
 * by `DuplicateDetectionService.evictFromDuplicateGroups` (see CLAUDE.md's
 * duplicate-detection section) — an item in a burst group is not supposed to be
 * in a duplicate group at all, and if a race left it in both, the burst grouping
 * is the authoritative one.
 */
export function collapseKey(candidate: MemoryCandidate): string {
  if (candidate.burstGroupId) return `b:${candidate.burstGroupId}`;
  if (candidate.duplicateGroupId) return `d:${candidate.duplicateGroupId}`;
  return `i:${candidate.id}`;
}

/**
 * Collapse burst/duplicate groups down to one representative each, preferring
 * the group's own `suggestedBestItemId` when it survived the base filter.
 *
 * Pure (the suggested-best map is resolved by the caller) so the interesting
 * behavior is unit-testable without a database.
 */
export function collapseGroups(
  scored: ScoredCandidate[],
  suggestedBestByKey: Map<string, string | null>,
): ScoredCandidate[] {
  const groups = new Map<string, ScoredCandidate[]>();
  for (const c of scored) {
    const key = collapseKey(c);
    const bucket = groups.get(key);
    if (bucket) bucket.push(c);
    else groups.set(key, [c]);
  }

  const kept: ScoredCandidate[] = [];
  for (const [key, members] of groups) {
    if (members.length === 1) {
      kept.push(members[0]!);
      continue;
    }
    const suggested = suggestedBestByKey.get(key) ?? null;
    // The suggested best only wins if it is itself a candidate — it may have
    // been archived, trashed or flagged since the group was formed.
    const winner =
      (suggested ? members.find((m) => m.id === suggested) : undefined) ??
      [...members].sort(compareForSelection)[0]!;
    kept.push(winner);
  }
  return kept;
}

/**
 * Pick up to `maxItems` items that span the memory's time range instead of
 * clustering on whichever moment happened to be photographed hardest.
 *
 * Two passes: divide the span into equal buckets and take each bucket's best,
 * then fill any remaining slots with the next-best overall. The video cap is
 * enforced throughout, so a rejected video simply leaves its slot to the fill
 * pass rather than shrinking the memory.
 *
 * Pure — exported for unit testing.
 */
export function selectDiverse(scored: ScoredCandidate[], maxItems: number): ScoredCandidate[] {
  if (scored.length === 0 || maxItems <= 0) return [];

  const ranked = [...scored].sort(compareForSelection);

  const selected = new Map<string, ScoredCandidate>();
  let videoCount = 0;

  const tryAdd = (c: ScoredCandidate | undefined): void => {
    if (!c || selected.has(c.id) || selected.size >= maxItems) return;
    if (c.type === MediaType.video) {
      if (videoCount >= MAX_VIDEOS_PER_MEMORY) return;
      videoCount += 1;
    }
    selected.set(c.id, c);
  };

  let minTime = Infinity;
  let maxTime = -Infinity;
  for (const c of ranked) {
    const t = c.capturedAt.getTime();
    if (t < minTime) minTime = t;
    if (t > maxTime) maxTime = t;
  }
  const span = maxTime - minTime;

  if (span > 0) {
    const bucketCount = Math.max(1, Math.min(maxItems, ranked.length));
    const bucketBest = new Map<number, ScoredCandidate>();
    // `ranked` is best-first, so the first arrival in a bucket IS its best.
    for (const c of ranked) {
      const idx = Math.min(
        bucketCount - 1,
        Math.floor(((c.capturedAt.getTime() - minTime) / span) * bucketCount),
      );
      if (!bucketBest.has(idx)) bucketBest.set(idx, c);
    }
    for (let i = 0; i < bucketCount; i += 1) tryAdd(bucketBest.get(i));
  }

  // Fill pass — covers a zero-span set, buckets skipped by the video cap, and
  // any slots left when there are fewer buckets than maxItems.
  for (const c of ranked) {
    if (selected.size >= maxItems) break;
    tryAdd(c);
  }

  return [...selected.values()];
}

/**
 * Turn a chosen set into the final, ordered `CuratedSelection`: chronological
 * ascending positions, and a cover that is never a video.
 *
 * Pure — exported for unit testing.
 */
export function finalizeSelection(
  chosen: ScoredCandidate[],
  candidateCount: number,
  truncated: boolean,
): CuratedSelection {
  const ordered = [...chosen].sort((a, b) => {
    const at = a.capturedAt.getTime();
    const bt = b.capturedAt.getTime();
    if (at !== bt) return at - bt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const items: CuratedItem[] = ordered.map((c, index) => ({
    mediaItemId: c.id,
    position: index,
    score: c.score,
  }));

  // A video never becomes the cover: cover art is rendered as a still, and a
  // video's poster frame is a different (and often worse) image than any photo
  // in the set. An all-video memory simply has no cover.
  let cover: ScoredCandidate | null = null;
  for (const c of ordered) {
    if (c.type === MediaType.video) continue;
    if (!cover || c.score > cover.score || (c.score === cover.score && c.id < cover.id)) {
      cover = c;
    }
  }

  return {
    items,
    coverMediaItemId: cover?.id ?? null,
    periodStart: ordered.length > 0 ? ordered[0]!.capturedAt : null,
    periodEnd: ordered.length > 0 ? ordered[ordered.length - 1]!.capturedAt : null,
    candidateCount,
    truncated,
  };
}

/**
 * Jaccard DISTANCE between two media-item id sets: `1 - |A∩B| / |A∪B|`.
 *
 * Two empty sets are defined as distance 0 (nothing changed), which keeps a
 * degenerate refresh from being reported as material.
 */
export function membershipDistance(before: Iterable<string>, after: Iterable<string>): number {
  const a = new Set(before);
  const b = new Set(after);
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const id of a) if (b.has(id)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : 1 - intersection / union;
}

/** Split an array into fixed-size chunks (for bounded `IN (...)` predicates). */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

@Injectable()
export class MemoryCurationService {
  private readonly logger = new Logger(MemoryCurationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Stream every candidate matching the base filter AND the curator's `where`,
   * hydrated with the scoring signals.
   *
   * Constant memory in the number of PAGES: one page of rows plus two batched
   * signal lookups are live at a time; only the (capped) candidate array grows.
   * Ordering is `(capturedAt ASC, id ASC)` — a total order, since `capturedAt`
   * is non-null under the base filter — which makes the keyset cursor exact with
   * no NULLS-handling and no rows skipped or repeated across pages.
   */
  async loadCandidates(
    circleId: string,
    where: Prisma.MediaItemWhereInput,
    options: { maxCandidates?: number } = {},
  ): Promise<{ candidates: MemoryCandidate[]; truncated: boolean }> {
    const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    const base = memoryCandidateBaseWhere(circleId);

    const candidates: MemoryCandidate[] = [];
    let truncated = false;
    let cursor: { capturedAt: Date; id: string } | null = null;

    for (;;) {
      const cursorPredicate: Prisma.MediaItemWhereInput | null = cursor
        ? {
            OR: [
              { capturedAt: { gt: cursor.capturedAt } },
              { capturedAt: cursor.capturedAt, id: { gt: cursor.id } },
            ],
          }
        : null;

      // Explicitly annotated: without it TypeScript reports TS7022, because the
      // page's `where` is built from `cursor`, which is in turn assigned from
      // this very result — a self-reference the inferencer cannot break.
      const rows: CandidateRow[] = await this.prisma.mediaItem.findMany({
        where: cursorPredicate ? { AND: [base, where, cursorPredicate] } : { AND: [base, where] },
        orderBy: [{ capturedAt: 'asc' }, { id: 'asc' }],
        take: CANDIDATE_PAGE_SIZE,
        select: {
          id: true,
          capturedAt: true,
          type: true,
          durationMs: true,
          favorite: true,
          sharpnessScore: true,
          burstGroupId: true,
          duplicateGroupId: true,
          description: true,
        },
      });
      if (rows.length === 0) break;

      const last = rows[rows.length - 1]!;
      // `capturedAt` cannot be null here (base filter), but the generated type
      // still says it can — assert once, at the cursor, rather than per row.
      cursor = { capturedAt: last.capturedAt as Date, id: last.id };

      const pageIds = rows.map((r) => r.id);
      const [favoritePersonIds, aiTaggedIds] = await Promise.all([
        this.mediaItemsWithFavoritePersonFace(pageIds),
        this.mediaItemsWithAiTags(pageIds),
      ]);

      for (const row of rows) {
        if (candidates.length >= maxCandidates) {
          truncated = true;
          break;
        }
        candidates.push({
          id: row.id,
          capturedAt: row.capturedAt as Date,
          type: row.type,
          durationMs: row.durationMs,
          favorite: row.favorite,
          sharpnessScore: row.sharpnessScore,
          burstGroupId: row.burstGroupId,
          duplicateGroupId: row.duplicateGroupId,
          hasAiContent:
            (row.description != null && row.description.trim().length > 0) ||
            aiTaggedIds.has(row.id),
          hasFavoritePersonFace: favoritePersonIds.has(row.id),
        });
      }

      if (truncated) {
        this.logger.warn(
          `Memory candidate scan for circle ${circleId} hit the ${maxCandidates}-item cap; ` +
            'the tail of the slice was not considered',
        );
        break;
      }
      if (rows.length < CANDIDATE_PAGE_SIZE) break;
    }

    return { candidates, truncated };
  }

  /** Which of these items carry a face assigned to a live, favorite Person. */
  private async mediaItemsWithFavoritePersonFace(ids: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (ids.length === 0) return found;
    for (const part of chunk(ids, IN_CHUNK)) {
      const rows = await this.prisma.face.findMany({
        where: {
          mediaItemId: { in: part },
          personId: { not: null },
          // A hidden or soft-deleted person is not a signal the user wants
          // surfaced — hiding a person is an explicit "stop showing me this".
          person: { favorite: true, hiddenAt: null, deletedAt: null },
        },
        select: { mediaItemId: true },
        distinct: ['mediaItemId'],
      });
      for (const r of rows) found.add(r.mediaItemId);
    }
    return found;
  }

  /** Which of these items carry at least one AI-applied tag. */
  private async mediaItemsWithAiTags(ids: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (ids.length === 0) return found;
    for (const part of chunk(ids, IN_CHUNK)) {
      const rows = await this.prisma.mediaTag.findMany({
        where: { mediaItemId: { in: part }, source: MediaTagSource.ai },
        select: { mediaItemId: true },
        distinct: ['mediaItemId'],
      });
      for (const r of rows) found.add(r.mediaItemId);
    }
    return found;
  }

  /**
   * Resolve `suggestedBestItemId` for every burst/duplicate group present in the
   * candidate set, keyed by the same `collapseKey()` the collapse pass uses.
   */
  private async resolveSuggestedBest(
    candidates: MemoryCandidate[],
  ): Promise<Map<string, string | null>> {
    const burstIds = new Set<string>();
    const duplicateIds = new Set<string>();
    for (const c of candidates) {
      if (c.burstGroupId) burstIds.add(c.burstGroupId);
      // Only groups that can actually win a bucket are worth resolving — an
      // item with a burst group never collapses on its duplicate group.
      else if (c.duplicateGroupId) duplicateIds.add(c.duplicateGroupId);
    }

    const map = new Map<string, string | null>();
    for (const part of chunk([...burstIds], IN_CHUNK)) {
      const rows = await this.prisma.burstGroup.findMany({
        where: { id: { in: part } },
        select: { id: true, suggestedBestItemId: true },
      });
      for (const r of rows) map.set(`b:${r.id}`, r.suggestedBestItemId);
    }
    for (const part of chunk([...duplicateIds], IN_CHUNK)) {
      const rows = await this.prisma.duplicateGroup.findMany({
        where: { id: { in: part } },
        select: { id: true, suggestedBestItemId: true },
      });
      for (const r of rows) map.set(`d:${r.id}`, r.suggestedBestItemId);
    }
    return map;
  }

  /**
   * The full pipeline for one memory's slice:
   * load (base filter + curator `where`) → score → collapse near-duplicates →
   * diversity-select → order chronologically and pick a cover.
   */
  async curate(
    circleId: string,
    where: Prisma.MediaItemWhereInput,
    options: CurateOptions,
  ): Promise<CuratedSelection> {
    const { candidates, truncated } = await this.loadCandidates(circleId, where, {
      maxCandidates: options.maxCandidates,
    });
    if (candidates.length === 0) {
      return finalizeSelection([], 0, truncated);
    }

    const scored = scoreCandidates(candidates);
    const suggestedBest = await this.resolveSuggestedBest(candidates);
    const collapsed = collapseGroups(scored, suggestedBest);
    const chosen = selectDiverse(collapsed, options.maxItems);
    return finalizeSelection(chosen, candidates.length, truncated);
  }

  /**
   * Write a curated selection under its `(circleId, type, periodKey,
   * subjectKey)` identity — creating it, or refreshing it in place.
   *
   * THE TOMBSTONE CHECK COMES FIRST, before any write and before any title
   * computation, because "the user deleted this" outranks everything else this
   * method could do.
   *
   * `MemoryUserState` is untouched by design: it lives in its own table keyed by
   * memory id, so a refresh that replaces every item still preserves seen /
   * hidden / favorited state for every user. That is the whole reason per-user
   * state was not modeled as columns on `Memory`.
   */
  async upsertMemory(input: UpsertMemoryInput): Promise<UpsertMemoryResult> {
    const subjectKey = input.subjectKey ?? '';
    const identity = {
      circleId_type_periodKey_subjectKey: {
        circleId: input.circleId,
        type: input.type,
        periodKey: input.periodKey,
        subjectKey,
      },
    };

    const existing = await this.prisma.memory.findUnique({
      where: identity,
      select: { id: true, deletedAt: true, items: { select: { mediaItemId: true } } },
    });

    if (existing?.deletedAt) {
      this.logger.debug(
        `Memory ${input.type}/${input.periodKey}/${subjectKey} in circle ${input.circleId} ` +
          'is tombstoned; upsert refused',
      );
      return { memoryId: null, created: false, materiallyChanged: false, skippedTombstone: true };
    }

    if (!existing) {
      try {
        const memoryId = await this.createMemory(input, subjectKey);
        return { memoryId, created: true, materiallyChanged: true, skippedTombstone: false };
      } catch (err) {
        // A concurrent generation pass won the race on the unique key. Re-read
        // and fall through to the refresh path — including its tombstone check,
        // since the winner could in principle already have been deleted.
        if (
          !(err instanceof Prisma.PrismaClientKnownRequestError) ||
          err.code !== 'P2002'
        ) {
          throw err;
        }
        const raced = await this.prisma.memory.findUnique({
          where: identity,
          select: { id: true, deletedAt: true, items: { select: { mediaItemId: true } } },
        });
        if (!raced || raced.deletedAt) {
          return {
            memoryId: null,
            created: false,
            materiallyChanged: false,
            skippedTombstone: raced != null,
          };
        }
        return this.refreshMemory(input, raced);
      }
    }

    return this.refreshMemory(input, existing);
  }

  private buildMeta(input: UpsertMemoryInput): Prisma.InputJsonValue {
    return {
      ...(input.meta ?? {}),
      generatorVersion: MEMORY_GENERATOR_VERSION,
    } as Prisma.InputJsonValue;
  }

  private async createMemory(input: UpsertMemoryInput, subjectKey: string): Promise<string> {
    const now = new Date();
    const { periodStart, periodEnd } = this.resolvePeriod(input, now);

    return this.prisma.$transaction(async (tx) => {
      const memory = await tx.memory.create({
        data: {
          circleId: input.circleId,
          type: input.type,
          periodKey: input.periodKey,
          subjectKey,
          personId: input.personId ?? null,
          title: input.title,
          subtitle: input.subtitle ?? null,
          // Narrative is an AI-only field (#306); a template-titled memory has
          // none, and writing an empty string instead of NULL would make
          // "has a narrative" untestable downstream.
          narrative: null,
          titleSource: 'template',
          titleModel: null,
          coverMediaItemId: input.selection.coverMediaItemId,
          periodStart,
          periodEnd,
          itemCount: input.selection.items.length,
          meta: this.buildMeta(input),
          generatedAt: now,
          refreshedAt: now,
          expiresAt: input.expiresAt ?? null,
        },
        select: { id: true },
      });

      if (input.selection.items.length > 0) {
        await tx.memoryItem.createMany({
          data: input.selection.items.map((item) => ({
            memoryId: memory.id,
            mediaItemId: item.mediaItemId,
            position: item.position,
            score: item.score,
          })),
        });
      }

      return memory.id;
    });
  }

  private async refreshMemory(
    input: UpsertMemoryInput,
    existing: { id: string; items: Array<{ mediaItemId: string }> },
  ): Promise<UpsertMemoryResult> {
    const now = new Date();
    const { periodStart, periodEnd } = this.resolvePeriod(input, now);

    const distance = membershipDistance(
      existing.items.map((i) => i.mediaItemId),
      input.selection.items.map((i) => i.mediaItemId),
    );
    const materiallyChanged = distance >= MATERIAL_CHANGE_THRESHOLD;

    await this.prisma.$transaction(async (tx) => {
      // Replace rather than diff: MemoryItem carries no per-item user state, so
      // a wholesale replacement is both simpler and cheaper than computing an
      // add/remove/reposition delta, and `position` shifts on almost every
      // refresh anyway.
      await tx.memoryItem.deleteMany({ where: { memoryId: existing.id } });
      if (input.selection.items.length > 0) {
        await tx.memoryItem.createMany({
          data: input.selection.items.map((item) => ({
            memoryId: existing.id,
            mediaItemId: item.mediaItemId,
            position: item.position,
            score: item.score,
          })),
        });
      }

      await tx.memory.update({
        where: { id: existing.id },
        data: {
          coverMediaItemId: input.selection.coverMediaItemId,
          periodStart,
          periodEnd,
          itemCount: input.selection.items.length,
          meta: this.buildMeta(input),
          refreshedAt: now,
          expiresAt: input.expiresAt ?? null,
          personId: input.personId ?? null,
          // Titling is preserved on a minor refresh — including an AI title and
          // narrative from #306. On a MATERIAL change the old title may now
          // describe a set that no longer exists, so it is reset to the
          // template and handed back to AI re-titling on a later pass.
          ...(materiallyChanged
            ? {
                title: input.title,
                subtitle: input.subtitle ?? null,
                narrative: null,
                titleSource: 'template',
                titleModel: null,
              }
            : {}),
        },
      });
    });

    return {
      memoryId: existing.id,
      created: false,
      materiallyChanged,
      skippedTombstone: false,
    };
  }

  /**
   * `periodStart`/`periodEnd` are NOT NULL in the schema, but a selection can
   * legitimately be empty (a curator upserting a now-empty period). Fall back to
   * "now" for both so the row stays writable and self-consistent rather than
   * blowing up a whole generation run over a degenerate edge.
   */
  private resolvePeriod(
    input: UpsertMemoryInput,
    fallback: Date,
  ): { periodStart: Date; periodEnd: Date } {
    return {
      periodStart: input.selection.periodStart ?? fallback,
      periodEnd: input.selection.periodEnd ?? fallback,
    };
  }
}
