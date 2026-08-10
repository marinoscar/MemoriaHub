/**
 * Unit tests for parseMemoryGenerationPayload (epic #300, issue #315).
 *
 * `EnrichmentJob.payload` is JSONB: it can be null (every scheduled run), hand-
 * edited from /admin/settings/jobs, or written by a different release. The
 * parser's whole contract is that NOTHING in it throws and every malformed
 * field degrades to "absent" — which means the full, unsharded behaviour, i.e.
 * doing more work rather than less. That is the safe direction: a job that runs
 * every curator is merely slower, whereas one that silently runs none would
 * leave an admin's backfill looking complete while producing nothing.
 */

import { parseMemoryGenerationPayload } from './memory-generation.payload';

describe('parseMemoryGenerationPayload', () => {
  it.each([null, undefined, 'string', 42, [], true])(
    'treats a non-object payload (%p) as a scheduled, unsharded run',
    (raw) => {
      expect(parseMemoryGenerationPayload(raw)).toEqual({});
    },
  );

  it('reports backfill: false for an object payload that omits it', () => {
    expect(parseMemoryGenerationPayload({})).toEqual({ backfill: false });
  });

  it('reads a full shard payload', () => {
    expect(
      parseMemoryGenerationPayload({
        backfill: true,
        curators: ['on_this_day'],
        anchorMonths: [3],
        aiTitleCap: 5,
      }),
    ).toEqual({
      backfill: true,
      curators: ['on_this_day'],
      anchorMonths: [3],
      aiTitleCap: 5,
    });
  });

  it('requires backfill to be literally true', () => {
    expect(parseMemoryGenerationPayload({ backfill: 'yes' }).backfill).toBe(false);
    expect(parseMemoryGenerationPayload({ backfill: 1 }).backfill).toBe(false);
  });

  it('drops non-string curator names and an empty list', () => {
    expect(parseMemoryGenerationPayload({ curators: [1, null, 'trip'] }).curators).toEqual([
      'trip',
    ]);
    // Empty means "no restriction", not "run nothing".
    expect(parseMemoryGenerationPayload({ curators: [] }).curators).toBeUndefined();
    expect(parseMemoryGenerationPayload({ curators: 'trip' }).curators).toBeUndefined();
  });

  it('drops out-of-range and non-integer months', () => {
    expect(
      parseMemoryGenerationPayload({ anchorMonths: [0, 1, 12, 13, 6.5, '3'] }).anchorMonths,
    ).toEqual([1, 12]);
    expect(parseMemoryGenerationPayload({ anchorMonths: [99] }).anchorMonths).toBeUndefined();
  });

  it('floors a fractional AI cap and rejects a negative or non-numeric one', () => {
    expect(parseMemoryGenerationPayload({ aiTitleCap: 5.9 }).aiTitleCap).toBe(5);
    expect(parseMemoryGenerationPayload({ aiTitleCap: 0 }).aiTitleCap).toBe(0);
    expect(parseMemoryGenerationPayload({ aiTitleCap: -1 }).aiTitleCap).toBeUndefined();
    expect(parseMemoryGenerationPayload({ aiTitleCap: 'lots' }).aiTitleCap).toBeUndefined();
  });
});
