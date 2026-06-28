/**
 * Unit tests for rate-limit.error.ts
 *
 * Covers:
 *  - RateLimitError class: instanceof, name, message, retryAfterMs, providerKey
 *  - classifyRateLimit: 429 via status / response.status / $metadata.httpStatusCode,
 *    AWS throttle names, Retry-After extraction, null for unrelated errors
 *  - parseRetryAfterMs: integer seconds, HTTP-date, past date, garbage/undefined
 */

import {
  RateLimitError,
  classifyRateLimit,
  parseRetryAfterMs,
} from './rate-limit.error';

// ============================================================================
// RateLimitError class
// ============================================================================

describe('RateLimitError', () => {
  it('is an instance of Error', () => {
    const err = new RateLimitError('rate limited');
    expect(err).toBeInstanceOf(Error);
  });

  it('is an instance of RateLimitError', () => {
    const err = new RateLimitError('rate limited');
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it('has name set to "RateLimitError"', () => {
    const err = new RateLimitError('test');
    expect(err.name).toBe('RateLimitError');
  });

  it('stores the message', () => {
    const err = new RateLimitError('too many requests');
    expect(err.message).toBe('too many requests');
  });

  it('stores retryAfterMs when provided', () => {
    const err = new RateLimitError('msg', 5000);
    expect(err.retryAfterMs).toBe(5000);
  });

  it('retryAfterMs is undefined when not provided', () => {
    const err = new RateLimitError('msg');
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('stores providerKey when provided', () => {
    const err = new RateLimitError('msg', undefined, 'anthropic');
    expect(err.providerKey).toBe('anthropic');
  });

  it('providerKey is undefined when not provided', () => {
    const err = new RateLimitError('msg');
    expect(err.providerKey).toBeUndefined();
  });
});

// ============================================================================
// classifyRateLimit
// ============================================================================

describe('classifyRateLimit', () => {
  // -------------------------------------------------------------------------
  // HTTP 429 detection paths
  // -------------------------------------------------------------------------

  describe('HTTP 429 via err.status', () => {
    it('returns a RateLimitError for { status: 429 }', () => {
      const result = classifyRateLimit({ status: 429, message: 'Too Many Requests' });
      expect(result).toBeInstanceOf(RateLimitError);
    });

    it('returns a RateLimitError for { status: 529 } (Anthropic Overloaded)', () => {
      const result = classifyRateLimit({ status: 529, message: 'Overloaded' });
      expect(result).toBeInstanceOf(RateLimitError);
    });

    it('message is taken from err.message for 529', () => {
      const result = classifyRateLimit({ status: 529, message: 'Service overloaded' });
      expect(result!.message).toBe('Service overloaded');
    });

    it('uses a default message containing 529 when err.message is absent', () => {
      const result = classifyRateLimit({ status: 529 });
      expect(result!.message).toContain('529');
    });

    it('message is taken from err.message when present', () => {
      const result = classifyRateLimit({ status: 429, message: 'custom msg' });
      expect(result!.message).toBe('custom msg');
    });

    it('uses a default message when err.message is absent', () => {
      const result = classifyRateLimit({ status: 429 });
      expect(result!.message).toContain('429');
    });
  });

  describe('HTTP 429 via err.response.status', () => {
    it('returns a RateLimitError for { response: { status: 429 } }', () => {
      const result = classifyRateLimit({ response: { status: 429 } });
      expect(result).toBeInstanceOf(RateLimitError);
    });

    it('extracts Retry-After from err.response.headers', () => {
      const result = classifyRateLimit({
        response: {
          status: 429,
          headers: { 'retry-after': '30' },
        },
      });
      expect(result).toBeInstanceOf(RateLimitError);
      expect(result!.retryAfterMs).toBe(30_000);
    });

    it('extracts Retry-After (capital casing) from response headers', () => {
      const result = classifyRateLimit({
        response: {
          status: 429,
          headers: { 'Retry-After': '10' },
        },
      });
      expect(result!.retryAfterMs).toBe(10_000);
    });
  });

  describe('HTTP 429 via err.$metadata.httpStatusCode', () => {
    it('returns a RateLimitError for { $metadata: { httpStatusCode: 429 } }', () => {
      const result = classifyRateLimit({ $metadata: { httpStatusCode: 429 } });
      expect(result).toBeInstanceOf(RateLimitError);
    });
  });

  // -------------------------------------------------------------------------
  // AWS throttle error names
  // -------------------------------------------------------------------------

  describe('AWS throttle names', () => {
    const awsThrottleNames = [
      'ThrottlingException',
      'TooManyRequestsException',
      'ProvisionedThroughputExceededException',
      'RequestLimitExceeded',
      'SlowDown',
    ];

    for (const name of awsThrottleNames) {
      it(`returns RateLimitError for name="${name}"`, () => {
        const result = classifyRateLimit({ name, message: `AWS: ${name}` });
        expect(result).toBeInstanceOf(RateLimitError);
      });
    }

    it('uses a default message when err.message is missing on AWS throttle', () => {
      const result = classifyRateLimit({ name: 'ThrottlingException' });
      expect(result!.message).toContain('ThrottlingException');
    });
  });

  // -------------------------------------------------------------------------
  // Retry-After header extraction
  // -------------------------------------------------------------------------

  describe('Retry-After extraction', () => {
    it('parses integer seconds Retry-After header into retryAfterMs', () => {
      const result = classifyRateLimit({
        status: 429,
        response: { status: 429, headers: { 'retry-after': '60' } },
      });
      expect(result!.retryAfterMs).toBe(60_000);
    });

    it('Retry-After is undefined when not present', () => {
      const result = classifyRateLimit({ status: 429 });
      expect(result!.retryAfterMs).toBeUndefined();
    });

    it('parses Retry-After from err.headers (AWS-style direct headers)', () => {
      const result = classifyRateLimit({
        name: 'ThrottlingException',
        headers: { 'retry-after': '15' },
      });
      expect(result!.retryAfterMs).toBe(15_000);
    });
  });

  // -------------------------------------------------------------------------
  // Returns null for non-rate-limit errors
  // -------------------------------------------------------------------------

  describe('returns null for unrelated errors', () => {
    it('returns null for a plain Error instance', () => {
      expect(classifyRateLimit(new Error('some error'))).toBeNull();
    });

    it('returns null for { status: 500 }', () => {
      expect(classifyRateLimit({ status: 500 })).toBeNull();
    });

    it('returns null for { status: 400 }', () => {
      expect(classifyRateLimit({ status: 400 })).toBeNull();
    });

    it('returns null for { status: 401 }', () => {
      expect(classifyRateLimit({ status: 401 })).toBeNull();
    });

    it('returns null for { status: 403 }', () => {
      expect(classifyRateLimit({ status: 403 })).toBeNull();
    });

    it('returns null for null', () => {
      expect(classifyRateLimit(null)).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(classifyRateLimit(undefined)).toBeNull();
    });

    it('returns null for a plain string', () => {
      expect(classifyRateLimit('error')).toBeNull();
    });

    it('returns null for an empty object', () => {
      expect(classifyRateLimit({})).toBeNull();
    });

    it('returns null for a non-throttle AWS error name', () => {
      expect(classifyRateLimit({ name: 'ValidationException' })).toBeNull();
    });

    it('returns null for { response: { status: 500 } }', () => {
      expect(classifyRateLimit({ response: { status: 500 } })).toBeNull();
    });
  });
});

// ============================================================================
// parseRetryAfterMs
// ============================================================================

describe('parseRetryAfterMs', () => {
  // -------------------------------------------------------------------------
  // Integer seconds
  // -------------------------------------------------------------------------

  describe('integer seconds', () => {
    it('converts "30" (seconds) to 30000 ms', () => {
      expect(parseRetryAfterMs('30')).toBe(30_000);
    });

    it('converts "0" to 0 ms', () => {
      expect(parseRetryAfterMs('0')).toBe(0);
    });

    it('converts "1" to 1000 ms', () => {
      expect(parseRetryAfterMs('1')).toBe(1000);
    });

    it('converts "120" to 120000 ms', () => {
      expect(parseRetryAfterMs('120')).toBe(120_000);
    });

    it('trims whitespace before parsing', () => {
      expect(parseRetryAfterMs('  45  ')).toBe(45_000);
    });
  });

  // -------------------------------------------------------------------------
  // HTTP-date
  // -------------------------------------------------------------------------

  describe('HTTP-date string', () => {
    it('converts a future HTTP-date to a positive ms value', () => {
      // Create a date 5 minutes in the future
      const future = new Date(Date.now() + 5 * 60 * 1000);
      const httpDate = future.toUTCString();
      const result = parseRetryAfterMs(httpDate);
      // Should be within a 5-second window of 300000 ms
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThanOrEqual(5 * 60 * 1000 + 5000);
    });

    it('returns 0 (or small value) for a past HTTP-date', () => {
      const past = new Date(Date.now() - 60_000); // 1 minute in the past
      const result = parseRetryAfterMs(past.toUTCString());
      // Math.max(0, negative) → 0
      expect(result).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Garbage / missing values
  // -------------------------------------------------------------------------

  describe('garbage / missing values', () => {
    it('returns null for undefined', () => {
      expect(parseRetryAfterMs(undefined)).toBeNull();
    });

    it('returns null for null', () => {
      expect(parseRetryAfterMs(null)).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(parseRetryAfterMs('')).toBeNull();
    });

    it('returns null for a non-numeric, non-date string', () => {
      expect(parseRetryAfterMs('garbage-value')).toBeNull();
    });

    it('returns null for a word-only garbage string', () => {
      // Neither integer nor valid date
      expect(parseRetryAfterMs('not-a-number')).toBeNull();
    });
  });
});
