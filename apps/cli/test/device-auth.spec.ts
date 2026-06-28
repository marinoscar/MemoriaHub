/**
 * device-auth.spec.ts — Unit tests for RFC 8628 Device Authorization Flow client
 *
 * Speed strategy for polling tests:
 *   We use jest.useFakeTimers() so that setTimeout() resolves instantly when
 *   jest.runAllTimersAsync() is called. The polling loop calls
 *   sleep(currentInterval * 1000) before each poll; with fake timers all
 *   those sleeps resolve at once, making polling tests sub-millisecond in
 *   real wall-clock time despite the code thinking it waited seconds.
 *
 *   For the expired-deadline test we pass expiresInSec=0 so the while-loop
 *   condition (Date.now() < deadline) is false immediately and no sleep or
 *   fetch is ever called.
 *
 *   For slow_down we pass a large expiresInSec so the deadline is far in the
 *   future; fake timers advance through the increased interval instantly.
 */

import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Set up fake timers before any module imports so that the module under test
// picks up the fake setTimeout when it is loaded. We restore them in afterAll.
// ---------------------------------------------------------------------------
jest.useFakeTimers();

// Store the fetch mock reference so individual tests can reconfigure it.
const mockFetch = jest.fn<typeof fetch>();
(globalThis as any).fetch = mockFetch;

// Dynamic import AFTER setting up fetch mock
const { requestDeviceCode, pollForDeviceToken } = await import('../src/device-auth.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJsonResponse(body: unknown, status: number = 200): Response {
  const json = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(json),
    headers: new Headers(),
  } as unknown as Response;
}

function makeDeviceCodeEnvelope(overrides: Record<string, unknown> = {}): Response {
  return makeJsonResponse({
    data: {
      deviceCode: 'dc_opaque_abc123',
      userCode: 'ABCD-1234',
      verificationUri: 'https://example.com/activate',
      verificationUriComplete: 'https://example.com/activate?code=ABCD-1234',
      expiresIn: 900,
      interval: 5,
      ...overrides,
    },
  });
}

function makeRfcError(
  rfcCode: string,
  description: string,
  httpStatus: number = 400,
): Response {
  return makeJsonResponse(
    {
      statusCode: httpStatus,
      code: 'BAD_REQUEST',
      message: description,
      error: rfcCode,
      error_description: description,
      timestamp: new Date().toISOString(),
      path: '/api/auth/device/token',
    },
    httpStatus,
  );
}

function makeTokenSuccess(accessToken: string = 'pat_successtoken'): Response {
  return makeJsonResponse({
    data: {
      accessToken,
      refreshToken: '',
      tokenType: 'Bearer',
      expiresIn: 7776000, // 90 days
    },
  });
}

/**
 * Start a pollForDeviceToken call and drive its internal setTimeout sleeps
 * forward by running all pending timers repeatedly until the promise settles.
 *
 * Returns the resolved/rejected value.
 */
async function drivePolling(
  serverUrl: string,
  deviceCode: string,
  expiresInSec: number = 3600,
  onTick?: (state: 'pending' | 'slow_down') => void,
) {
  const promise = pollForDeviceToken(serverUrl, deviceCode, 5, expiresInSec, onTick);

  // Drain the internal timer/microtask queue until the promise settles.
  // We alternate between advancing timers and flushing microtasks.
  // maxCycles guards against infinite loops in case of unexpected behavior.
  const maxCycles = 50;
  for (let i = 0; i < maxCycles; i++) {
    await jest.runAllTimersAsync();
    // Give Promises a chance to resolve
    await Promise.resolve();
    // Check if the promise has already settled
    let settled = false;
    await promise.then(() => { settled = true; }, () => { settled = true; });
    if (settled) break;
  }

  return promise;
}

// ---------------------------------------------------------------------------
// requestDeviceCode
// ---------------------------------------------------------------------------

describe('requestDeviceCode', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should POST to /api/auth/device/code and return unwrapped data', async () => {
    mockFetch.mockResolvedValueOnce(makeDeviceCodeEnvelope());

    const result = await requestDeviceCode('https://example.com', {
      tokenType: 'pat',
      name: 'MemoriaHub CLI',
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/api/auth/device/code');
    expect(opts.method).toBe('POST');

    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({
      clientInfo: { tokenType: 'pat', name: 'MemoriaHub CLI' },
    });

    expect(result.deviceCode).toBe('dc_opaque_abc123');
    expect(result.userCode).toBe('ABCD-1234');
    expect(result.verificationUri).toBe('https://example.com/activate');
    expect(result.verificationUriComplete).toBe(
      'https://example.com/activate?code=ABCD-1234',
    );
    expect(result.expiresIn).toBe(900);
    expect(result.interval).toBe(5);
  });

  it('should strip trailing slash from serverUrl', async () => {
    mockFetch.mockResolvedValueOnce(makeDeviceCodeEnvelope());

    await requestDeviceCode('https://example.com/', { tokenType: 'pat' });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/api/auth/device/code');
  });

  it('should send Content-Type and Accept JSON headers', async () => {
    mockFetch.mockResolvedValueOnce(makeDeviceCodeEnvelope());

    await requestDeviceCode('https://example.com', { tokenType: 'pat' });

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toBe('application/json');
  });

  it('should throw on non-OK response', async () => {
    mockFetch.mockResolvedValueOnce(
      makeJsonResponse(
        { statusCode: 500, message: 'Internal Server Error' },
        500,
      ),
    );

    await expect(
      requestDeviceCode('https://example.com', { tokenType: 'pat' }),
    ).rejects.toThrow(/Device code request failed/);
  });

  it('should throw on non-JSON response body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: () => Promise.resolve('<html>Service Unavailable</html>'),
      headers: new Headers(),
    } as unknown as Response);

    await expect(
      requestDeviceCode('https://example.com', { tokenType: 'pat' }),
    ).rejects.toThrow(/non-JSON/);
  });

  it('should throw when response envelope is missing data field', async () => {
    mockFetch.mockResolvedValueOnce(makeJsonResponse({ result: {} }));

    await expect(
      requestDeviceCode('https://example.com', { tokenType: 'pat' }),
    ).rejects.toThrow(/Unexpected response shape/);
  });
});

// ---------------------------------------------------------------------------
// pollForDeviceToken
// ---------------------------------------------------------------------------

describe('pollForDeviceToken', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should return accessToken immediately when first poll succeeds', async () => {
    mockFetch.mockResolvedValue(makeTokenSuccess('pat_first_try'));

    const tokenPromise = pollForDeviceToken('https://example.com', 'dc_abc', 5, 3600);
    await jest.runAllTimersAsync();
    const result = await tokenPromise;

    expect(result.accessToken).toBe('pat_first_try');
    // makeTokenSuccess provides expiresIn: 7776000, so expiresAt must be computed
    expect(result.expiresAt).toBeDefined();
    expect(typeof result.expiresAt).toBe('string');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should POST to /api/auth/device/token with deviceCode in body', async () => {
    mockFetch.mockResolvedValue(makeTokenSuccess());

    const tokenPromise = pollForDeviceToken('https://example.com', 'my_device_code_123', 5, 3600);
    await jest.runAllTimersAsync();
    await tokenPromise;

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/api/auth/device/token');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(body.deviceCode).toBe('my_device_code_123');
  });

  it('should keep polling through authorization_pending and resolve on approval', async () => {
    mockFetch
      .mockResolvedValueOnce(makeRfcError('authorization_pending', 'Not yet'))
      .mockResolvedValueOnce(makeRfcError('authorization_pending', 'Not yet'))
      .mockResolvedValueOnce(makeTokenSuccess('pat_after_wait'));

    const result = await drivePolling('https://example.com', 'dc_abc');

    expect(result.accessToken).toBe('pat_after_wait');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('should call onTick with "pending" for each authorization_pending response', async () => {
    const ticks: Array<'pending' | 'slow_down'> = [];

    mockFetch
      .mockResolvedValueOnce(makeRfcError('authorization_pending', 'Not yet'))
      .mockResolvedValueOnce(makeRfcError('authorization_pending', 'Still not'))
      .mockResolvedValueOnce(makeTokenSuccess());

    await drivePolling('https://example.com', 'dc', 3600, (state) => {
      ticks.push(state);
    });

    expect(ticks).toEqual(['pending', 'pending']);
  });

  it('should back off on slow_down and still resolve on approval', async () => {
    const ticks: Array<'pending' | 'slow_down'> = [];

    mockFetch
      .mockResolvedValueOnce(makeRfcError('slow_down', 'Too fast'))
      .mockResolvedValueOnce(makeTokenSuccess('pat_after_slowdown'));

    const result = await drivePolling(
      'https://example.com',
      'dc',
      9999,
      (state) => ticks.push(state),
    );

    expect(result.accessToken).toBe('pat_after_slowdown');
    expect(ticks).toEqual(['slow_down']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should call onTick with "slow_down" on slow_down response', async () => {
    const ticks: Array<'pending' | 'slow_down'> = [];

    mockFetch
      .mockResolvedValueOnce(makeRfcError('slow_down', 'Slow down'))
      .mockResolvedValueOnce(makeTokenSuccess());

    await drivePolling('https://example.com', 'dc', 9999, (state) => {
      ticks.push(state);
    });

    expect(ticks).toContain('slow_down');
  });

  it('should reject with clear error on expired_token', async () => {
    mockFetch.mockResolvedValue(makeRfcError('expired_token', 'Code expired'));

    // Attach the rejection expectation BEFORE running timers so the rejection
    // is always handled (avoids unhandledRejection with fake-timer approach).
    const promise = pollForDeviceToken('https://example.com', 'dc', 5, 3600);
    const expectation = expect(promise).rejects.toThrow(/device code has expired/i);
    await jest.runAllTimersAsync();
    await expectation;
  });

  it('should reject with clear error on access_denied', async () => {
    mockFetch.mockResolvedValue(makeRfcError('access_denied', 'User denied'));

    const promise = pollForDeviceToken('https://example.com', 'dc', 5, 3600);
    const expectation = expect(promise).rejects.toThrow(/denied/i);
    await jest.runAllTimersAsync();
    await expectation;
  });

  it('should reject when expiresInSec is 0 (already-expired deadline)', async () => {
    // With expiresInSec=0 deadline is already in the past; while loop never runs
    const promise = pollForDeviceToken('https://example.com', 'dc', 5, 0);

    // No timers are scheduled so just drain the microtask queue
    await Promise.resolve();

    await expect(promise).rejects.toThrow(/timed out/i);
    // fetch should never have been called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should treat 400 BAD_REQUEST with no RFC error field as authorization_pending (backward compat)', async () => {
    // A pre-fix server that returns 400 without the 'error' field
    const noRfcFieldResponse = makeJsonResponse(
      {
        statusCode: 400,
        code: 'BAD_REQUEST',
        message: 'An unexpected error occurred',
        timestamp: new Date().toISOString(),
        path: '/api/auth/device/token',
        // NOTE: no 'error' field
      },
      400,
    );

    mockFetch
      .mockResolvedValueOnce(noRfcFieldResponse)
      .mockResolvedValueOnce(makeTokenSuccess('pat_compat'));

    const result = await drivePolling('https://example.com', 'dc');
    expect(result.accessToken).toBe('pat_compat');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should reject with error message on unexpected non-4xx error', async () => {
    mockFetch.mockResolvedValue(
      makeJsonResponse({ statusCode: 503, message: 'Service unavailable' }, 503),
    );

    const promise = pollForDeviceToken('https://example.com', 'dc', 5, 3600);
    const expectation = expect(promise).rejects.toThrow(/Service unavailable|Unexpected error/i);
    await jest.runAllTimersAsync();
    await expectation;
  });

  it('should strip trailing slash from serverUrl', async () => {
    mockFetch.mockResolvedValue(makeTokenSuccess());

    const tokenPromise = pollForDeviceToken('https://example.com/', 'dc', 5, 3600);
    await jest.runAllTimersAsync();
    await tokenPromise;

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/api/auth/device/token');
  });

  it('should continue polling after non-JSON response (treats as transient)', async () => {
    const nonJsonResponse: Response = {
      ok: false,
      status: 200,
      text: () => Promise.resolve('NOT JSON'),
      headers: new Headers(),
    } as unknown as Response;

    mockFetch
      .mockResolvedValueOnce(nonJsonResponse)
      .mockResolvedValueOnce(makeTokenSuccess('pat_after_parse_error'));

    const result = await drivePolling('https://example.com', 'dc');
    expect(result.accessToken).toBe('pat_after_parse_error');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

afterAll(() => {
  jest.useRealTimers();
});
