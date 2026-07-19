/**
 * Unit tests for the CLIP session bounded-lifetime recycling helpers
 * (`releaseClipSession` / `DEFAULT_CLIP_RECYCLE_AFTER`) in
 * packages/enrichment-compute/src/clip/index.ts.
 *
 * These are pure, host-independent behaviors: the host (apps/api's
 * VisualEmbeddingService, or the CLI worker) decides WHEN to recycle a
 * session, but the actual release call is centralized here so both hosts
 * stay in sync and a failed release never throws — a session leak must never
 * crash a job. See the doc comment on `releaseClipSession` in
 * src/clip/index.ts for the full rationale.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('DEFAULT_CLIP_RECYCLE_AFTER is a positive integer equal to 1000', async () => {
  const { DEFAULT_CLIP_RECYCLE_AFTER } = await import('@memoriahub/enrichment-compute/clip');

  assert.equal(typeof DEFAULT_CLIP_RECYCLE_AFTER, 'number');
  assert.equal(Number.isInteger(DEFAULT_CLIP_RECYCLE_AFTER), true);
  assert.ok(DEFAULT_CLIP_RECYCLE_AFTER > 0);
  assert.equal(DEFAULT_CLIP_RECYCLE_AFTER, 1000);
});

test('releaseClipSession calls release() on a session that has one, and resolves', async () => {
  const { releaseClipSession } = await import('@memoriahub/enrichment-compute/clip');

  let called = false;
  const fakeSession = {
    release: async () => {
      called = true;
    },
  };

  await assert.doesNotReject(releaseClipSession(fakeSession));
  assert.equal(called, true);
});

test('releaseClipSession swallows a throwing release() and still resolves', async () => {
  const { releaseClipSession } = await import('@memoriahub/enrichment-compute/clip');

  const fakeSession = {
    release: () => {
      throw new Error('boom');
    },
  };

  await assert.doesNotReject(releaseClipSession(fakeSession));
});

test('releaseClipSession resolves without throwing when the session has no release() method', async () => {
  const { releaseClipSession } = await import('@memoriahub/enrichment-compute/clip');

  await assert.doesNotReject(releaseClipSession({}));
});
