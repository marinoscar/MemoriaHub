/**
 * test/api.spec.ts — ApiClient retry + cooldown integration (mocked fetch).
 */

import { jest } from '@jest/globals';
import { ApiClient, ApiError } from '../src/api.js';
import { CooldownGate } from '../src/http/cooldown-gate.js';

// Fast retry/cooldown so the real setTimeout sleeps are negligible.
const FAST_RETRY = { maxRetries: 4, baseMs: 1, maxMs: 2 };
const NO_COOLDOWN = new CooldownGate({ cooldownMs: 0, maxCooldownMs: 0 });

function makeClient(gate = NO_COOLDOWN): ApiClient {
  return new ApiClient({
    serverUrl: 'https://example.test',
    pat: 'pat-123',
    retry: FAST_RETRY,
    cooldownGate: gate,
  });
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function mockFetchSequence(responses: Array<() => Response>): jest.Mock {
  let i = 0;
  const fn = jest.fn(async () => {
    const make = responses[Math.min(i, responses.length - 1)];
    i++;
    return make();
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('ApiClient retry behavior', () => {
  it('retries a 503 then returns the unwrapped data envelope', async () => {
    const fetchMock = mockFetchSequence([
      () => new Response('{"message":"slow"}', { status: 503 }),
      () => new Response('{"data":{"ok":true}}', { status: 200 }),
    ]);
    const api = makeClient();
    await expect(api.get<{ ok: boolean }>('/api/thing')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 429 on POST then succeeds', async () => {
    const fetchMock = mockFetchSequence([
      () => new Response('{"message":"rate"}', { status: 429 }),
      () => new Response('{"data":{"id":"x"}}', { status: 200 }),
    ]);
    const api = makeClient();
    await expect(api.post('/api/thing', { a: 1 })).resolves.toEqual({ id: 'x' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 400 and surfaces the server message', async () => {
    const fetchMock = mockFetchSequence([
      () => new Response('{"message":"bad input"}', { status: 400 }),
    ]);
    const api = makeClient();
    await expect(api.get('/api/thing')).rejects.toMatchObject({
      status: 400,
      serverMessage: 'bad input',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws ApiError after exhausting retries', async () => {
    mockFetchSequence([() => new Response('nope', { status: 503 })]);
    const api = makeClient();
    await expect(api.get('/api/thing')).rejects.toBeInstanceOf(ApiError);
    expect(global.fetch).toHaveBeenCalledTimes(FAST_RETRY.maxRetries + 1);
  });

  it('retries a transport (network) failure', async () => {
    let calls = 0;
    global.fetch = jest.fn(async () => {
      calls++;
      if (calls < 2) throw new TypeError('fetch failed');
      return new Response('{"data":1}', { status: 200 });
    }) as unknown as typeof fetch;
    const api = makeClient();
    await expect(api.get<number>('/api/thing')).resolves.toBe(1);
    expect(calls).toBe(2);
  });
});

describe('ApiClient putRaw', () => {
  it('returns the ETag on success', async () => {
    mockFetchSequence([
      () => new Response(null, { status: 200, headers: { etag: '"etag-1"' } }),
    ]);
    const api = makeClient();
    await expect(api.putRaw('https://s3.test/part', Buffer.from('x'))).resolves.toBe(
      '"etag-1"',
    );
  });

  it('retries an S3 503 SlowDown body then succeeds', async () => {
    const fetchMock = mockFetchSequence([
      () =>
        new Response('<Error><Code>SlowDown</Code></Error>', { status: 503 }),
      () => new Response(null, { status: 200, headers: { etag: '"e2"' } }),
    ]);
    const api = makeClient();
    await expect(api.putRaw('https://s3.test/part', Buffer.from('x'))).resolves.toBe(
      '"e2"',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('ApiClient + cooldown gate', () => {
  it('trips the shared gate on a throttle response', async () => {
    const gate = new CooldownGate({ cooldownMs: 50, maxCooldownMs: 100 });
    const tripSpy = jest.spyOn(gate, 'trip');
    mockFetchSequence([
      () => new Response('{"message":"rate"}', { status: 429 }),
      () => new Response('{"data":1}', { status: 200 }),
    ]);
    const api = makeClient(gate);
    await api.get('/api/thing');
    expect(tripSpy).toHaveBeenCalled();
  });
});
