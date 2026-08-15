/**
 * services/media — bulkEnhanceByFilter (issue #424, epic #420 phase 4).
 *
 * `serializeEnhanceFilters` exists to fix a specific, money-losing failure
 * mode: the API's `bulkEnhanceByFilterSchema` spreads the shared
 * `mediaFilterFields`, whose boolean-ish fields (`favorite`, `missingGeo`,
 * `missingCapturedAt`, `missingCamera`, `noFaces`) are
 * `z.string().transform(v => v === 'true' ? true : v === 'false' ? false :
 * undefined)` — written for a QUERY STRING. A real JSON `true` sent in a POST
 * body transforms to `undefined` server-side and the filter is silently
 * DROPPED — which on THIS endpoint WIDENS the match set, enhancing photos the
 * caller never asked about and never saw. That is the load-bearing behavior
 * under test here, via MSW intercepting the real HTTP call and inspecting the
 * JSON body actually sent (mirroring mediaExtended.test.ts's approach) —
 * `serializeEnhanceFilters` itself is not exported, so it is exercised only
 * through the public `bulkEnhanceByFilter` service call, exactly as a caller
 * would.
 */

import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { bulkEnhanceByFilter } from '../../services/media';
import type { BulkEnhanceByFilterFilters } from '../../services/media';
import { ApiError } from '../../services/api';

const ROUTE = '*/api/media/bulk/enhance/by-filter';

const mockResult = {
  batchId: 'batch-1',
  requested: 5,
  queued: 5,
  skipped: { notPhoto: 0, tooLarge: 0, alreadyLive: 0 },
};

/** Wires the by-filter route to capture and echo back the JSON body sent. */
function captureBody(): { body: () => Record<string, unknown> | undefined } {
  let captured: Record<string, unknown> | undefined;
  server.use(
    http.post(ROUTE, async ({ request }) => {
      captured = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(mockResult);
    }),
  );
  return { body: () => captured };
}

describe('bulkEnhanceByFilter — request body serialization', () => {
  // -------------------------------------------------------------------------
  // THE money-losing failure mode this module exists to prevent.
  // -------------------------------------------------------------------------
  describe('boolean filters survive serialization as the strings "true"/"false"', () => {
    it('serializes every boolean-ish field as the STRING "true", never the raw JSON boolean', async () => {
      const capture = captureBody();

      const filters: BulkEnhanceByFilterFilters = {
        circleId: 'circle-1',
        favorite: true,
        missingGeo: true,
        missingCapturedAt: true,
        missingCamera: true,
        noFaces: true,
      };

      await bulkEnhanceByFilter({ filters });

      const body = capture.body();
      expect(body).toBeDefined();
      expect(body!.favorite).toBe('true');
      expect(body!.missingGeo).toBe('true');
      expect(body!.missingCapturedAt).toBe('true');
      expect(body!.missingCamera).toBe('true');
      expect(body!.noFaces).toBe('true');
      // The exact failure under test: if this were the raw boolean `true`,
      // the API's z.string().transform(...) would silently turn it into
      // `undefined` and drop the filter, widening the match set.
      expect(typeof body!.favorite).toBe('string');
      expect(body!.favorite).not.toBe(true);
    });

    it('serializes false booleans as the STRING "false" — never omitted, never the raw boolean', async () => {
      const capture = captureBody();

      const filters: BulkEnhanceByFilterFilters = {
        circleId: 'circle-1',
        favorite: false,
        noFaces: false,
      };

      await bulkEnhanceByFilter({ filters });

      const body = capture.body();
      expect(body!.favorite).toBe('false');
      expect(body!.noFaces).toBe('false');
      expect(typeof body!.favorite).toBe('string');
    });
  });

  // -------------------------------------------------------------------------
  // excludeArchived is dropped, not forwarded — the server pins
  // `archivedAt: null` unconditionally on this endpoint.
  // -------------------------------------------------------------------------
  describe('excludeArchived', () => {
    it('is never sent — sending it would suggest a choice the caller does not have on this endpoint', async () => {
      const capture = captureBody();

      await bulkEnhanceByFilter({
        filters: { circleId: 'circle-1', excludeArchived: true } as BulkEnhanceByFilterFilters,
      });

      const body = capture.body();
      expect(body).toBeDefined();
      expect(body).not.toHaveProperty('excludeArchived');
    });
  });

  // -------------------------------------------------------------------------
  // undefined/null filter values are omitted entirely, not sent as null.
  // -------------------------------------------------------------------------
  describe('undefined/null filter values', () => {
    it('omits keys whose value is undefined or null rather than sending them', async () => {
      const capture = captureBody();

      await bulkEnhanceByFilter({
        filters: {
          circleId: 'circle-1',
          tag: undefined,
          country: undefined,
        } as BulkEnhanceByFilterFilters,
      });

      const body = capture.body();
      expect(body).toBeDefined();
      expect(body).not.toHaveProperty('tag');
      expect(body).not.toHaveProperty('country');
      expect(body!.circleId).toBe('circle-1');
    });
  });

  // -------------------------------------------------------------------------
  // Non-boolean values pass through untouched.
  // -------------------------------------------------------------------------
  describe('non-boolean values', () => {
    it('leaves string/array/enum filter values as-is', async () => {
      const capture = captureBody();

      await bulkEnhanceByFilter({
        filters: {
          circleId: 'circle-1',
          tag: 'Beach',
          personIds: ['p1', 'p2'],
          peopleMatch: 'all',
        } as BulkEnhanceByFilterFilters,
      });

      const body = capture.body();
      expect(body!.tag).toBe('Beach');
      expect(body!.personIds).toEqual(['p1', 'p2']);
      expect(body!.peopleMatch).toBe('all');
    });
  });

  // -------------------------------------------------------------------------
  // params passthrough
  // -------------------------------------------------------------------------
  describe('params', () => {
    it('is omitted from the body entirely when not supplied', async () => {
      const capture = captureBody();

      await bulkEnhanceByFilter({ filters: { circleId: 'circle-1' } });

      const body = capture.body();
      expect(body).toBeDefined();
      expect(body).not.toHaveProperty('params');
    });

    it('is included verbatim when supplied', async () => {
      const capture = captureBody();

      await bulkEnhanceByFilter({
        filters: { circleId: 'circle-1' },
        params: { strength: 'strong' },
      });

      const body = capture.body();
      expect(body!.params).toEqual({ strength: 'strong' });
    });
  });

  // -------------------------------------------------------------------------
  // Response / error propagation
  // -------------------------------------------------------------------------
  describe('response handling', () => {
    it('returns the parsed BulkEnhanceResult on success', async () => {
      server.use(http.post(ROUTE, () => HttpResponse.json(mockResult)));

      const result = await bulkEnhanceByFilter({ filters: { circleId: 'circle-1' } });
      expect(result).toEqual(mockResult);
    });

    it('surfaces details.matchedCount/maxBatchSize on the thrown ApiError for an over-cap 400', async () => {
      server.use(
        http.post(ROUTE, () =>
          HttpResponse.json(
            {
              message: '412 photos match this filter; the limit is 25 per batch.',
              code: 'BAD_REQUEST',
              details: { matchedCount: 412, maxBatchSize: 25 },
            },
            { status: 400 },
          ),
        ),
      );

      await expect(bulkEnhanceByFilter({ filters: { circleId: 'circle-1' } })).rejects.toMatchObject({
        status: 400,
        details: { matchedCount: 412, maxBatchSize: 25 },
      });
    });

    it('the rejected error is an ApiError instance carrying the server message for the empty-match 400', async () => {
      server.use(
        http.post(ROUTE, () =>
          HttpResponse.json(
            { message: 'No photos match this filter', code: 'BAD_REQUEST' },
            { status: 400 },
          ),
        ),
      );

      try {
        await bulkEnhanceByFilter({ filters: { circleId: 'circle-1' } });
        throw new Error('expected bulkEnhanceByFilter to reject');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).message).toBe('No photos match this filter');
        expect((err as ApiError).status).toBe(400);
      }
    });
  });
});
