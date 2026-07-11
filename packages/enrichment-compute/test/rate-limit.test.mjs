/**
 * Unit tests for @memoriahub/enrichment-compute/rate-limit —
 * parseRetryAfterMs + ProviderRateLimitError.
 *
 * The `/ai` and `/geo` subpaths' own tests (ai.test.mjs, geo.test.mjs) cover
 * how each provider-calling function classifies and throws this shared
 * signal; this file covers the shared primitives in isolation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('parseRetryAfterMs parses integer-seconds values into milliseconds', async () => {
  const { parseRetryAfterMs } = await import('@memoriahub/enrichment-compute/rate-limit');

  assert.equal(parseRetryAfterMs('30'), 30_000);
  assert.equal(parseRetryAfterMs('0'), 0);
});

test('parseRetryAfterMs parses an HTTP-date value into a millisecond delta', async () => {
  const { parseRetryAfterMs } = await import('@memoriahub/enrichment-compute/rate-limit');

  const future = new Date(Date.now() + 60_000).toUTCString();
  const ms = parseRetryAfterMs(future);
  // Allow slack for test execution time between Date.now() calls.
  assert.ok(ms !== undefined && ms > 50_000 && ms <= 60_000, `expected ~60000ms, got ${ms}`);
});

test('parseRetryAfterMs returns undefined for absent/unparseable values', async () => {
  const { parseRetryAfterMs } = await import('@memoriahub/enrichment-compute/rate-limit');

  assert.equal(parseRetryAfterMs(undefined), undefined);
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs(''), undefined);
  assert.equal(parseRetryAfterMs('not-a-number-or-date'), undefined);
});

test('ProviderRateLimitError carries message, provider, and retryAfterMs', async () => {
  const { ProviderRateLimitError } = await import('@memoriahub/enrichment-compute/rate-limit');

  const err = new ProviderRateLimitError('throttled', 'anthropic', 12_345);
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'ProviderRateLimitError');
  assert.equal(err.message, 'throttled');
  assert.equal(err.provider, 'anthropic');
  assert.equal(err.retryAfterMs, 12_345);
});

test('ProviderRateLimitError allows omitting provider and retryAfterMs', async () => {
  const { ProviderRateLimitError } = await import('@memoriahub/enrichment-compute/rate-limit');

  const err = new ProviderRateLimitError('throttled');
  assert.equal(err.provider, undefined);
  assert.equal(err.retryAfterMs, undefined);
});
