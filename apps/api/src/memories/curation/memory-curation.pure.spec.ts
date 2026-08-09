/**
 * Unit tests for the PURE half of the curation engine (issue #303): scoring,
 * near-duplicate collapse, diversity selection, finalization and the membership
 * distance that drives title preservation.
 *
 * These are exported as free functions precisely so they can be asserted with
 * plain object literals — no Nest module graph, no Prisma. The DB-dependent
 * half (base filter, keyset streaming, tombstone upsert) is covered against a
 * real PostgreSQL in test/memories/memories-curation.integration.spec.ts, where
 * mocking would prove nothing.
 */

import { MediaType } from '@prisma/client';
import {
  AI_CONTENT_BONUS,
  FAVORITE_BONUS,
  FAVORITE_PERSON_BONUS,
  LONG_VIDEO_PENALTY,
  MATERIAL_CHANGE_THRESHOLD,
  MAX_VIDEOS_PER_MEMORY,
  NEUTRAL_SHARPNESS,
  collapseGroups,
  collapseKey,
  finalizeSelection,
  isLongVideo,
  membershipDistance,
  memoryCandidateBaseWhere,
  scoreCandidate,
  scoreCandidates,
  selectDiverse,
} from './memory-curation.service';
import { MemoryCandidate } from './memory-curation.types';

const DAY = 86_400_000;
const BASE_TIME = Date.UTC(2019, 2, 12, 8, 0, 0);

function candidate(over: Partial<MemoryCandidate> & { id: string }): MemoryCandidate {
  return {
    capturedAt: new Date(BASE_TIME),
    type: MediaType.photo,
    durationMs: null,
    favorite: false,
    sharpnessScore: null,
    burstGroupId: null,
    duplicateGroupId: null,
    hasAiContent: false,
    hasFavoritePersonFace: false,
    ...over,
  };
}

describe('memoryCandidateBaseWhere', () => {
  it('encodes all four non-negotiable base predicates plus the circle scope', () => {
    // Asserted structurally because this object IS the contract: a curator can
    // never opt out of it, so a regression here silently leaks archived or
    // trashed photos into every memory type at once.
    expect(memoryCandidateBaseWhere('circle-1')).toEqual({
      circleId: 'circle-1',
      capturedAt: { not: null },
      deletedAt: null,
      archivedAt: null,
      socialMediaSource: null,
    });
  });
});

describe('scoreCandidate', () => {
  it('scores a bare candidate at the neutral sharpness only', () => {
    expect(scoreCandidate(candidate({ id: 'a' }))).toBeCloseTo(NEUTRAL_SHARPNESS);
  });

  it('adds the favorite bonus', () => {
    expect(scoreCandidate(candidate({ id: 'a', favorite: true }))).toBeCloseTo(
      FAVORITE_BONUS + NEUTRAL_SHARPNESS,
    );
  });

  it('normalizes sharpness into [0,1] and clamps a runaway value', () => {
    expect(scoreCandidate(candidate({ id: 'a', sharpnessScore: 500 }))).toBeCloseTo(0.5);
    expect(scoreCandidate(candidate({ id: 'a', sharpnessScore: 99_999 }))).toBeCloseTo(1);
    expect(scoreCandidate(candidate({ id: 'a', sharpnessScore: -5 }))).toBeCloseTo(0);
  });

  it('treats a NULL sharpness as neutral, not as blurry', () => {
    // The distinction matters: scoring "unmeasured" as 0 would push every
    // pre-feature import and every video out of every memory.
    expect(scoreCandidate(candidate({ id: 'a', sharpnessScore: null }))).toBeGreaterThan(
      scoreCandidate(candidate({ id: 'b', sharpnessScore: 0 })),
    );
  });

  it('adds the favorite-person and AI-content bonuses', () => {
    const score = scoreCandidate(
      candidate({ id: 'a', hasFavoritePersonFace: true, hasAiContent: true, sharpnessScore: 0 }),
    );
    expect(score).toBeCloseTo(FAVORITE_PERSON_BONUS + AI_CONTENT_BONUS);
  });
});

describe('video preference', () => {
  it('flags long and unknown-duration videos, never photos', () => {
    expect(isLongVideo(candidate({ id: 'a', type: MediaType.video, durationMs: 120_000 }))).toBe(
      true,
    );
    expect(isLongVideo(candidate({ id: 'b', type: MediaType.video, durationMs: null }))).toBe(true);
    expect(isLongVideo(candidate({ id: 'c', type: MediaType.video, durationMs: 30_000 }))).toBe(
      false,
    );
    expect(isLongVideo(candidate({ id: 'd', durationMs: 999_999 }))).toBe(false);
  });

  it('penalizes selectionScore only, leaving the persisted score pure', () => {
    const [short, long] = scoreCandidates([
      candidate({ id: 'short', type: MediaType.video, durationMs: 10_000 }),
      candidate({ id: 'long', type: MediaType.video, durationMs: 600_000 }),
    ]);
    expect(long!.score).toBeCloseTo(short!.score);
    expect(long!.selectionScore).toBeCloseTo(long!.score - LONG_VIDEO_PENALTY);
    expect(short!.selectionScore).toBeCloseTo(short!.score);
  });
});

describe('collapse', () => {
  it('prefers the burst group when an item carries both group ids', () => {
    // Mirrors the app-wide rule that a burst-grouped item should not be in a
    // duplicate group at all (DuplicateDetectionService.evictFromDuplicateGroups).
    expect(collapseKey(candidate({ id: 'a', burstGroupId: 'B', duplicateGroupId: 'D' }))).toBe(
      'b:B',
    );
    expect(collapseKey(candidate({ id: 'a', duplicateGroupId: 'D' }))).toBe('d:D');
    expect(collapseKey(candidate({ id: 'a' }))).toBe('i:a');
  });

  it('keeps the group suggestedBestItemId when it is among the candidates', () => {
    const scored = scoreCandidates([
      candidate({ id: 'best', burstGroupId: 'B' }),
      // Higher-scored, but the group already has an opinion about which shot won.
      candidate({ id: 'sharp', burstGroupId: 'B', favorite: true }),
    ]);

    const kept = collapseGroups(scored, new Map([['b:B', 'best']]));

    expect(kept.map((c) => c.id)).toEqual(['best']);
  });

  it('falls back to the highest-scored member when the suggested best is filtered out', () => {
    // e.g. the suggested best was archived or trashed since the group formed —
    // it never reached the candidate set, so the group must still contribute.
    const scored = scoreCandidates([
      candidate({ id: 'plain', burstGroupId: 'B' }),
      candidate({ id: 'fav', burstGroupId: 'B', favorite: true }),
    ]);

    const kept = collapseGroups(scored, new Map([['b:B', 'archived-item']]));

    expect(kept.map((c) => c.id)).toEqual(['fav']);
  });

  it('contributes at most one item per group and leaves ungrouped items alone', () => {
    const scored = scoreCandidates([
      candidate({ id: 'b1', burstGroupId: 'B' }),
      candidate({ id: 'b2', burstGroupId: 'B' }),
      candidate({ id: 'b3', burstGroupId: 'B' }),
      candidate({ id: 'd1', duplicateGroupId: 'D' }),
      candidate({ id: 'd2', duplicateGroupId: 'D' }),
      candidate({ id: 'solo' }),
    ]);

    const kept = collapseGroups(scored, new Map());

    expect(kept).toHaveLength(3);
    expect(kept.filter((c) => c.burstGroupId === 'B')).toHaveLength(1);
    expect(kept.filter((c) => c.duplicateGroupId === 'D')).toHaveLength(1);
    expect(kept.some((c) => c.id === 'solo')).toBe(true);
  });
});

describe('selectDiverse', () => {
  /** n candidates one hour apart, scored so index order == quality order. */
  function spread(n: number, over: (i: number) => Partial<MemoryCandidate> = () => ({})) {
    return scoreCandidates(
      Array.from({ length: n }, (_, i) =>
        candidate({
          id: `i${String(i).padStart(3, '0')}`,
          capturedAt: new Date(BASE_TIME + i * 3_600_000),
          sharpnessScore: 100,
          ...over(i),
        }),
      ),
    );
  }

  it('returns everything when there is less material than the cap', () => {
    expect(selectDiverse(spread(4), 30)).toHaveLength(4);
  });

  it('is empty for an empty candidate set or a zero cap', () => {
    expect(selectDiverse([], 30)).toEqual([]);
    expect(selectDiverse(spread(5), 0)).toEqual([]);
  });

  it('spreads across the time span instead of taking one clustered moment', () => {
    // 30 shots inside one minute, plus 3 lone shots hours apart. A pure
    // top-N-by-score pick would return 30 near-identical frames of one moment.
    const cluster = scoreCandidates(
      Array.from({ length: 30 }, (_, i) =>
        candidate({
          id: `c${String(i).padStart(2, '0')}`,
          capturedAt: new Date(BASE_TIME + i * 1_000),
          favorite: true,
        }),
      ),
    );
    const spaced = scoreCandidates([
      candidate({ id: 'far1', capturedAt: new Date(BASE_TIME + 4 * 3_600_000) }),
      candidate({ id: 'far2', capturedAt: new Date(BASE_TIME + 8 * 3_600_000) }),
      candidate({ id: 'far3', capturedAt: new Date(BASE_TIME + 11 * 3_600_000) }),
    ]);

    const picked = selectDiverse([...cluster, ...spaced], 5);

    expect(picked).toHaveLength(5);
    // Every lower-scored but temporally distinct shot earns a slot.
    expect(picked.map((c) => c.id)).toEqual(expect.arrayContaining(['far1', 'far2', 'far3']));
  });

  it('still fills the cap when the whole set shares one timestamp', () => {
    const same = scoreCandidates(
      Array.from({ length: 10 }, (_, i) => candidate({ id: `s${i}` })),
    );
    expect(selectDiverse(same, 4)).toHaveLength(4);
  });

  it('caps videos and backfills the freed slots with photos', () => {
    const videos = spread(8, (i) => ({
      type: MediaType.video,
      durationMs: 10_000,
      favorite: true,
      id: `v${i}`,
    }));
    const photos = spread(8, (i) => ({ id: `p${i}` }));

    const picked = selectDiverse([...videos, ...photos], 10);

    expect(picked).toHaveLength(10);
    expect(picked.filter((c) => c.type === MediaType.video)).toHaveLength(MAX_VIDEOS_PER_MEMORY);
  });

  it('returns fewer than the cap when the video cap is the binding constraint', () => {
    const videos = spread(8, (i) => ({ type: MediaType.video, durationMs: 5_000, id: `v${i}` }));
    expect(selectDiverse(videos, 30)).toHaveLength(MAX_VIDEOS_PER_MEMORY);
  });

  it('is deterministic: the same input yields the same selection', () => {
    const input = spread(50, (i) => ({ favorite: i % 3 === 0 }));
    const a = selectDiverse(input, 12).map((c) => c.id);
    const b = selectDiverse([...input].reverse(), 12).map((c) => c.id);
    expect(new Set(a)).toEqual(new Set(b));
  });
});

describe('finalizeSelection', () => {
  const chosen = scoreCandidates([
    candidate({ id: 'late', capturedAt: new Date(BASE_TIME + 2 * DAY), sharpnessScore: 200 }),
    candidate({ id: 'early', capturedAt: new Date(BASE_TIME), sharpnessScore: 100 }),
    candidate({ id: 'mid', capturedAt: new Date(BASE_TIME + DAY), favorite: true }),
  ]);

  it('orders chronologically ascending with contiguous positions', () => {
    const selection = finalizeSelection(chosen, 3, false);
    expect(selection.items.map((i) => i.mediaItemId)).toEqual(['early', 'mid', 'late']);
    expect(selection.items.map((i) => i.position)).toEqual([0, 1, 2]);
  });

  it('persists the pure score on each item and reports the period bounds', () => {
    const selection = finalizeSelection(chosen, 3, false);
    expect(selection.items[1]!.score).toBeGreaterThan(selection.items[0]!.score);
    expect(selection.periodStart).toEqual(new Date(BASE_TIME));
    expect(selection.periodEnd).toEqual(new Date(BASE_TIME + 2 * DAY));
  });

  it('picks the highest-scored item as cover', () => {
    expect(finalizeSelection(chosen, 3, false).coverMediaItemId).toBe('mid');
  });

  it('never picks a video as cover, even when it is the best item', () => {
    const withVideo = scoreCandidates([
      candidate({ id: 'clip', type: MediaType.video, durationMs: 5_000, favorite: true }),
      candidate({ id: 'photo', capturedAt: new Date(BASE_TIME + DAY) }),
    ]);
    expect(finalizeSelection(withVideo, 2, false).coverMediaItemId).toBe('photo');
  });

  it('has no cover at all when the selection is entirely video', () => {
    const allVideo = scoreCandidates([
      candidate({ id: 'clip', type: MediaType.video, durationMs: 5_000 }),
    ]);
    expect(finalizeSelection(allVideo, 1, false).coverMediaItemId).toBeNull();
  });

  it('degrades cleanly on an empty selection', () => {
    const selection = finalizeSelection([], 0, false);
    expect(selection.items).toEqual([]);
    expect(selection.coverMediaItemId).toBeNull();
    expect(selection.periodStart).toBeNull();
    expect(selection.periodEnd).toBeNull();
  });
});

describe('membershipDistance', () => {
  it('is 0 for identical sets and for two empty sets', () => {
    expect(membershipDistance(['a', 'b'], ['b', 'a'])).toBe(0);
    expect(membershipDistance([], [])).toBe(0);
  });

  it('is 1 for disjoint sets', () => {
    expect(membershipDistance(['a'], ['b'])).toBe(1);
  });

  it('stays below the material threshold when one item joins a large set', () => {
    // 10 -> 11 items: the very churn the threshold exists to absorb, so an AI
    // title is not discarded and re-paid for because one photo arrived.
    const before = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const after = [...before, 'new'];
    expect(membershipDistance(before, after)).toBeLessThan(MATERIAL_CHANGE_THRESHOLD);
  });

  it('crosses the material threshold on a substantial reshuffle', () => {
    const before = ['a', 'b', 'c', 'd', 'e'];
    const after = ['a', 'b', 'c', 'x', 'y'];
    expect(membershipDistance(before, after)).toBeGreaterThanOrEqual(MATERIAL_CHANGE_THRESHOLD);
  });
});
