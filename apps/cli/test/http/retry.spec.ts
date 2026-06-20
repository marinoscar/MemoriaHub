/**
 * test/http/retry.spec.ts — unit tests for the rate-limit-aware retry engine.
 */

import { jest } from '@jest/globals';
import {
  parseRetryAfter,
  computeBackoffMs,
  classifyError,
  isRetryable,
  withRetry,
  type RetryConfig,
} from '../../src/http/retry.js';

const CFG: RetryConfig = { maxRetries: 3, baseMs: 100, maxMs: 1000 };

describe('parseRetryAfter', () => {
  it('parses integer seconds into ms', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('parses an HTTP-date relative to now', () => {
    const now = () => 1_000_000;
    const future = new Date(1_000_000 + 30_000).toUTCString();
    // toUTCString truncates to whole seconds, so allow a <1s slack.
    const ms = parseRetryAfter(future, now);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThanOrEqual(29_000);
    expect(ms!).toBeLessThanOrEqual(30_000);
  });

  it('clamps a past HTTP-date to 0', () => {
    const now = () => 2_000_000;
    const past = new Date(1_000_000).toUTCString();
    expect(parseRetryAfter(past, now)).toBe(0);
  });

  it('returns null for absent or unparseable values', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('not-a-date')).toBeNull();
  });
});

describe('computeBackoffMs', () => {
  it('grows exponentially and is capped at maxMs (full jitter, rand=1)', () => {
    const rand = () => 1; // jitter returns the full exp window
    expect(computeBackoffMs(1, CFG, null, rand)).toBe(100);
    expect(computeBackoffMs(2, CFG, null, rand)).toBe(200);
    expect(computeBackoffMs(3, CFG, null, rand)).toBe(400);
    // baseMs * 2^4 = 1600 → capped at maxMs (1000)
    expect(computeBackoffMs(5, CFG, null, rand)).toBe(1000);
  });

  it('applies jitter in [0, exp) when rand < 1', () => {
    expect(computeBackoffMs(3, CFG, null, () => 0)).toBe(0);
    expect(computeBackoffMs(3, CFG, null, () => 0.5)).toBe(200);
  });

  it('honors Retry-After as a floor', () => {
    // jitter would be 0, but Retry-After (under the maxMs*4 clamp) raises the floor.
    expect(computeBackoffMs(1, CFG, 3000, () => 0)).toBe(3000);
  });

  it('lets Retry-After exceed maxMs but clamps at maxMs*4', () => {
    expect(computeBackoffMs(1, CFG, 999_999, () => 0)).toBe(CFG.maxMs * 4);
  });
});

describe('classifyError / isRetryable', () => {
  it('treats 429/502/503/504 as retryable', () => {
    for (const status of [429, 502, 503, 504]) {
      expect(isRetryable({ status })).toBe(true);
    }
  });

  it('treats other 4xx as non-retryable', () => {
    for (const status of [400, 401, 403, 404, 409, 413, 422]) {
      expect(isRetryable({ status })).toBe(false);
    }
  });

  it('treats network errors and the explicit retryable flag as retryable', () => {
    expect(isRetryable({ isNetworkError: true })).toBe(true);
    expect(isRetryable({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryable({ status: 400, retryable: true })).toBe(true);
  });

  it('surfaces status + retryAfterMs in the classification', () => {
    expect(classifyError({ status: 429, retryAfterMs: 1234 })).toEqual({
      retryable: true,
      status: 429,
      retryAfterMs: 1234,
    });
  });

  it('treats non-objects as non-retryable', () => {
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable('boom')).toBe(false);
  });
});

describe('withRetry', () => {
  const noSleep = jest.fn(async () => {});

  beforeEach(() => noSleep.mockClear());

  it('retries a retryable failure then succeeds', async () => {
    let calls = 0;
    const fn = jest.fn(async () => {
      calls++;
      if (calls < 3) throw { status: 503 };
      return 'ok';
    });
    const result = await withRetry(fn, CFG, { sleep: noSleep, rand: () => 0 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(noSleep).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting maxRetries', async () => {
    const fn = jest.fn(async () => {
      throw { status: 503 };
    });
    await expect(
      withRetry(fn, CFG, { sleep: noSleep, rand: () => 0 }),
    ).rejects.toEqual({ status: 503 });
    // first try + maxRetries retries = 4 invocations
    expect(fn).toHaveBeenCalledTimes(CFG.maxRetries + 1);
  });

  it('does not retry a non-retryable error', async () => {
    const fn = jest.fn(async () => {
      throw { status: 400 };
    });
    await expect(withRetry(fn, CFG, { sleep: noSleep })).rejects.toEqual({
      status: 400,
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it('invokes onRetry with attempt + delay metadata', async () => {
    const onRetry = jest.fn();
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 2) throw { status: 429, retryAfterMs: 200 };
      return 1;
    };
    await withRetry(fn, CFG, { sleep: noSleep, rand: () => 0, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, status: 429, retryAfterMs: 200 }),
    );
  });
});
