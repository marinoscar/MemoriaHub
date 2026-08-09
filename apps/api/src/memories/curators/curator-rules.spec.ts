/**
 * Unit tests for the PURE decision rules of the #305 curators, plus the
 * calendar-bucketed selection they lean on.
 *
 * Three things live here that would be pointless (or impossible) to prove
 * against a database:
 *
 * - `selectByBuckets` — the round-robin fairness property. Whether a 30-item
 *   budget over twelve years yields two items from every year or four each from
 *   the first seven is a statement about an algorithm, not about SQL.
 * - `rankTagsForPeriod` — including that the all-history period is an exact sum
 *   of the per-year counts rather than an approximation.
 * - The year-in-review December/January eligibility window, which is a boundary
 *   rule with four distinct cases and no I/O at all.
 *
 * The DB-dependent halves (base filter, person eligibility SQL, the census
 * queries, the tombstone) are covered in
 * test/memories/memories-people.integration.spec.ts and
 * test/memories/memories-periodic.integration.spec.ts.
 */

import { MediaType } from '@prisma/client';
import { MAX_VIDEOS_PER_MEMORY, selectByBuckets } from '../curation/memory-curation.service';
import { MemoryCandidate, ScoredCandidate } from '../curation/memory-curation.types';
import { THEME_TAG_DENYLIST, rankTagsForPeriod } from './theme.curator';
import { isReviewYearEligible, scheduledReviewYear } from './year-in-review.curator';
import {
  PERSON_OVER_YEARS_MAX_PER_YEAR,
  PERSON_OVER_YEARS_MIN_YEARS,
} from './person-candidates';
import { monthBucket, yearBucket } from './period-windows';

function scored(over: Partial<MemoryCandidate> & { id: string; score: number }): ScoredCandidate {
  const { score, ...rest } = over;
  return {
    capturedAt: new Date(Date.UTC(2020, 0, 1)),
    type: MediaType.photo,
    durationMs: null,
    favorite: false,
    sharpnessScore: null,
    burstGroupId: null,
    duplicateGroupId: null,
    hasAiContent: false,
    hasFavoritePersonFace: false,
    score,
    selectionScore: score,
    ...rest,
  };
}

/** `count` candidates in `year`, descending in score so ranking is obvious. */
function yearOf(year: number, count: number): ScoredCandidate[] {
  return Array.from({ length: count }, (_, i) =>
    scored({
      id: `${year}-${i}`,
      score: 10 - i,
      capturedAt: new Date(Date.UTC(year, 0, 1 + i)),
    }),
  );
}

describe('selectByBuckets', () => {
  it('gives every bucket a turn before any bucket gets a second item', () => {
    // The property the whole function exists for. Bucket-at-a-time filling
    // would return ten items all from 2016 — chronologically biased in exactly
    // the way `person_over_years` must never be.
    const candidates = [...yearOf(2016, 10), ...yearOf(2020, 10), ...yearOf(2025, 10)];

    const picked = selectByBuckets(candidates, 3, yearBucket_, Number.POSITIVE_INFINITY);

    expect(picked.map((c) => c.capturedAt.getUTCFullYear()).sort()).toEqual([2016, 2020, 2025]);
  });

  it('caps any one bucket at maxPerBucket even when slots remain', () => {
    const candidates = [...yearOf(2016, 10), ...yearOf(2017, 10), ...yearOf(2018, 10)];

    const picked = selectByBuckets(candidates, 30, yearBucket_, PERSON_OVER_YEARS_MAX_PER_YEAR);

    // Three years x 4 = 12, not the full 30 budget: the cap is what makes the
    // memory a representative span rather than an album of one busy year.
    expect(picked).toHaveLength(3 * PERSON_OVER_YEARS_MAX_PER_YEAR);
    for (const year of [2016, 2017, 2018]) {
      expect(picked.filter((c) => c.capturedAt.getUTCFullYear() === year)).toHaveLength(
        PERSON_OVER_YEARS_MAX_PER_YEAR,
      );
    }
  });

  it('takes each bucket best-first', () => {
    const picked = selectByBuckets([...yearOf(2020, 5)], 2, yearBucket_, 4);
    expect(picked.map((c) => c.id)).toEqual(['2020-0', '2020-1']);
  });

  it('spreads a limited budget evenly across twelve month buckets', () => {
    const months = Array.from({ length: 12 }, (_, m) =>
      Array.from({ length: 10 }, (_, i) =>
        scored({
          id: `2025-${m}-${i}`,
          score: 10 - i,
          capturedAt: new Date(Date.UTC(2025, m, 1 + i)),
        }),
      ),
    ).flat();

    const picked = selectByBuckets(months, 30, (c) => monthBucket(c.capturedAt));

    expect(picked).toHaveLength(30);
    const perMonth = new Map<number, number>();
    for (const c of picked) {
      const m = c.capturedAt.getUTCMonth();
      perMonth.set(m, (perMonth.get(m) ?? 0) + 1);
    }
    // 30 items over 12 months: six months get 3, six get 2, none get 0.
    expect(perMonth.size).toBe(12);
    expect([...perMonth.values()].every((n) => n >= 2 && n <= 3)).toBe(true);
  });

  it('lets a bucket with material absorb the budget when others are exhausted', () => {
    const candidates = [...yearOf(2020, 1), ...yearOf(2021, 10)];

    const picked = selectByBuckets(candidates, 5, yearBucket_);

    // 2020 has one item and drops out after round 1; the rest of the budget is
    // not wasted holding slots open for a bucket that cannot fill them.
    expect(picked).toHaveLength(5);
    expect(picked.filter((c) => c.capturedAt.getUTCFullYear() === 2020)).toHaveLength(1);
  });

  it('enforces the video cap without costing the bucket its turn', () => {
    // Each year leads with a video; only MAX_VIDEOS_PER_MEMORY of them can be
    // taken, and every remaining year must still contribute its best PHOTO
    // rather than being skipped along with its rejected video.
    const candidates = Array.from({ length: 6 }, (_, i) => {
      const year = 2018 + i;
      return [
        scored({
          id: `v-${year}`,
          score: 100,
          type: MediaType.video,
          capturedAt: new Date(Date.UTC(year, 0, 1)),
        }),
        scored({ id: `p-${year}`, score: 5, capturedAt: new Date(Date.UTC(year, 0, 2)) }),
      ];
    }).flat();

    const picked = selectByBuckets(candidates, 6, yearBucket_, 1);

    expect(picked).toHaveLength(6);
    expect(picked.filter((c) => c.type === MediaType.video)).toHaveLength(MAX_VIDEOS_PER_MEMORY);
    // Every year is represented exactly once despite three videos being refused.
    expect(new Set(picked.map((c) => c.capturedAt.getUTCFullYear())).size).toBe(6);
  });

  it('returns empty for degenerate inputs rather than throwing', () => {
    expect(selectByBuckets([], 10, yearBucket_)).toEqual([]);
    expect(selectByBuckets(yearOf(2020, 3), 0, yearBucket_)).toEqual([]);
    expect(selectByBuckets(yearOf(2020, 3), 10, yearBucket_, 0)).toEqual([]);
  });

  it('is deterministic across repeated runs over the same input', () => {
    const candidates = [...yearOf(2016, 6), ...yearOf(2019, 6), ...yearOf(2024, 6)];
    const a = selectByBuckets(candidates, 7, yearBucket_, 4).map((c) => c.id);
    const b = selectByBuckets([...candidates].reverse(), 7, yearBucket_, 4).map((c) => c.id);
    // Input order must not matter: "re-running changes nothing" is only
    // testable if selection is a function of the candidate SET.
    expect(a.sort()).toEqual(b.sort());
  });

  function yearBucket_(c: ScoredCandidate): number {
    return yearBucket(c.capturedAt);
  }
});

describe('rankTagsForPeriod', () => {
  const census = [
    { tag: 'sunset', year: 2024, count: 5 },
    { tag: 'sunset', year: 2025, count: 9 },
    { tag: 'beach', year: 2025, count: 12 },
    { tag: 'pets', year: 2025, count: 4 },
  ];

  it('ranks a single year by that year alone, densest first', () => {
    expect(rankTagsForPeriod(census, 2025, 8)).toEqual([
      { tag: 'beach', count: 12 },
      { tag: 'sunset', count: 9 },
    ]);
  });

  it('drops tags under minItems for the period', () => {
    // "pets" (4) never appears; "sunset" appears for 2025 (9) but not 2024 (5).
    expect(rankTagsForPeriod(census, 2024, 8)).toEqual([]);
  });

  it('sums years EXACTLY for the all-history period', () => {
    // A media item has one capturedAt, so per-year distinct counts partition
    // the tag's all-history set — summing is exact, not an approximation. That
    // is what lets one grouped query serve every period.
    expect(rankTagsForPeriod(census, null, 8)).toEqual([
      { tag: 'sunset', count: 14 },
      { tag: 'beach', count: 12 },
    ]);
  });

  it('breaks count ties by name so the ranking is stable across runs', () => {
    const tied = [
      { tag: 'zebra', year: 2025, count: 10 },
      { tag: 'apple', year: 2025, count: 10 },
    ];
    expect(rankTagsForPeriod(tied, 2025, 8).map((t) => t.tag)).toEqual(['apple', 'zebra']);
  });

  it('returns empty for an empty census', () => {
    expect(rankTagsForPeriod([], 2025, 8)).toEqual([]);
  });
});

describe('THEME_TAG_DENYLIST', () => {
  it('covers the artifact-not-a-moment vocabulary named by issue #305', () => {
    for (const tag of ['screenshot', 'document', 'text', 'whiteboard']) {
      expect(THEME_TAG_DENYLIST.has(tag)).toBe(true);
    }
  });

  it('is lowercase throughout, since the census groups on LOWER(name)', () => {
    for (const tag of THEME_TAG_DENYLIST) expect(tag).toBe(tag.toLowerCase());
  });

  it('does not deny ordinary theme vocabulary', () => {
    for (const tag of ['sunset', 'beach', 'pets', 'birthday']) {
      expect(THEME_TAG_DENYLIST.has(tag)).toBe(false);
    }
  });
});

describe('year in review eligibility', () => {
  it('generates for the current year during December', () => {
    expect(scheduledReviewYear(new Date('2025-12-01T00:00:00.000Z'))).toBe(2025);
    expect(scheduledReviewYear(new Date('2025-12-31T23:59:59.000Z'))).toBe(2025);
  });

  it('keeps generating for the PREVIOUS year through all of January', () => {
    // The New Year reminiscing window: a memory that vanished on Dec 31 would
    // be gone before most of the circle went looking for it.
    expect(scheduledReviewYear(new Date('2026-01-01T00:00:00.000Z'))).toBe(2025);
    expect(scheduledReviewYear(new Date('2026-01-31T23:59:59.000Z'))).toBe(2025);
  });

  it('generates nothing from February through November', () => {
    for (const month of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(scheduledReviewYear(new Date(Date.UTC(2026, month, 15)))).toBeNull();
    }
  });

  it('treats any past year as eligible for backfill', () => {
    const now = new Date('2026-08-09T00:00:00.000Z');
    expect(isReviewYearEligible(2019, now)).toBe(true);
    expect(isReviewYearEligible(2025, now)).toBe(true);
  });

  it('refuses the still-running current year outside December', () => {
    // Otherwise a mid-year backfill mints a three-month "Your 2026 in review"
    // that then churns on every generation run for the rest of the year.
    expect(isReviewYearEligible(2026, new Date('2026-08-09T00:00:00.000Z'))).toBe(false);
    expect(isReviewYearEligible(2026, new Date('2026-12-05T00:00:00.000Z'))).toBe(true);
  });

  it('never treats a future year as eligible', () => {
    expect(isReviewYearEligible(2027, new Date('2026-12-05T00:00:00.000Z'))).toBe(false);
  });
});

describe('person curator thresholds', () => {
  it('requires at least three distinct years for a "through the years" memory', () => {
    // Two years is not a span; the per-year `person_highlights` memories
    // already tell that story better.
    expect(PERSON_OVER_YEARS_MIN_YEARS).toBe(3);
  });

  it('caps a single year at four items, per issue #305', () => {
    expect(PERSON_OVER_YEARS_MAX_PER_YEAR).toBe(4);
  });
});
