/**
 * test/backup/download.spec.ts — Verified resumable downloads (issue #316).
 *
 * Exercises the REAL ApiClient.getRaw against a mocked global fetch (so the
 * Range header, 206-vs-200 handling, cooldown-gate trip, and retry routing are
 * all covered), with downloadVerified layered on top for hashing/resume/
 * mismatch policy.
 */

import { jest } from '@jest/globals';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ApiClient } from '../../src/api.js';
import { CooldownGate } from '../../src/http/cooldown-gate.js';
import {
  downloadVerified,
  HashMismatchError,
  PresignExpiredError,
} from '../../src/backup/download.js';
import { TokenBucket } from '../../src/backup/rate-limiter.js';

const sha256 = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');

type FetchArgs = { url: string; headers: Record<string, string> };

/**
 * Range-aware fake origin. Each call to handler() may override behavior; by
 * default serves `content`, honoring Range with a 206.
 */
function makeFetchMock(
  content: Buffer,
  overrides: Array<(args: FetchArgs, call: number) => Response | null> = [],
): { fetchMock: jest.Mock; calls: FetchArgs[] } {
  const calls: FetchArgs[] = [];
  let call = 0;
  const fetchMock = jest.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const args = { url, headers };
    calls.push(args);
    const n = call++;
    for (const override of overrides) {
      const res = override(args, n);
      if (res) return res;
    }
    const range = headers['Range'];
    if (range) {
      const start = Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0);
      return new Response(new Uint8Array(content.subarray(start)), { status: 206 });
    }
    return new Response(new Uint8Array(content), { status: 200 });
  });
  return { fetchMock, calls };
}

function makeClient(gate?: CooldownGate): ApiClient {
  return new ApiClient({
    serverUrl: 'https://api.example.test',
    pat: 'pat_test',
    retry: { maxRetries: 2, baseMs: 1, maxMs: 2 },
    ...(gate ? { cooldownGate: gate } : {}),
  });
}

let tmpDir: string;
const realFetch = global.fetch;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-dl-'));
});

afterEach(() => {
  global.fetch = realFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function paths(): { dest: string; part: string } {
  return {
    dest: path.join(tmpDir, 'media', '2024', '01', 'photo.jpg'),
    part: path.join(tmpDir, 'tmp', 'item-1.part'),
  };
}

describe('downloadVerified', () => {
  const content = Buffer.from('the quick brown fox jumps over the lazy backup engine', 'utf8');

  it('downloads, verifies sha256 while streaming, and renames into place', async () => {
    const { fetchMock } = makeFetchMock(content);
    global.fetch = fetchMock as unknown as typeof fetch;
    const { dest, part } = paths();

    const res = await downloadVerified(
      { url: 'https://s3.test/obj', destAbsPath: dest, partAbsPath: part, contentHash: sha256(content) },
      { api: makeClient(), bucket: new TokenBucket(0) },
    );

    expect(res.sha256).toBe(sha256(content));
    expect(res.bytes).toBe(content.length);
    expect(fs.readFileSync(dest)).toEqual(content);
    expect(fs.existsSync(part)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resumes an existing .part with Range: bytes=N- and re-hashes the partial', async () => {
    const { fetchMock, calls } = makeFetchMock(content);
    global.fetch = fetchMock as unknown as typeof fetch;
    const { dest, part } = paths();

    // Pre-seed the first 20 bytes as a truncated .part.
    fs.mkdirSync(path.dirname(part), { recursive: true });
    fs.writeFileSync(part, content.subarray(0, 20));

    const res = await downloadVerified(
      { url: 'https://s3.test/obj', destAbsPath: dest, partAbsPath: part, contentHash: sha256(content) },
      { api: makeClient(), bucket: new TokenBucket(0) },
    );

    expect(calls[0]?.headers['Range']).toBe('bytes=20-');
    expect(res.sha256).toBe(sha256(content));
    expect(fs.readFileSync(dest)).toEqual(content);
  });

  it('restarts cleanly from zero when the server answers 200 instead of 206', async () => {
    // Overrides: always serve the FULL body with 200, ignoring Range.
    const { fetchMock, calls } = makeFetchMock(content, [
      () => new Response(new Uint8Array(content), { status: 200 }),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;
    const { dest, part } = paths();

    fs.mkdirSync(path.dirname(part), { recursive: true });
    fs.writeFileSync(part, content.subarray(0, 20));

    const res = await downloadVerified(
      { url: 'https://s3.test/obj', destAbsPath: dest, partAbsPath: part, contentHash: sha256(content) },
      { api: makeClient(), bucket: new TokenBucket(0) },
    );

    // Range was REQUESTED but not honored — file and hash restart from zero.
    expect(calls[0]?.headers['Range']).toBe('bytes=20-');
    expect(res.sha256).toBe(sha256(content));
    expect(fs.readFileSync(dest)).toEqual(content); // not doubled
  });

  it('retries ONCE from zero on hash mismatch, then succeeds when bytes are good', async () => {
    const corrupt = Buffer.from('corrupted bytes that hash differently', 'utf8');
    const { fetchMock } = makeFetchMock(content, [
      (_args, call) => (call === 0 ? new Response(new Uint8Array(corrupt), { status: 200 }) : null),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;
    const { dest, part } = paths();

    const res = await downloadVerified(
      { url: 'https://s3.test/obj', destAbsPath: dest, partAbsPath: part, contentHash: sha256(content) },
      { api: makeClient(), bucket: new TokenBucket(0) },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.sha256).toBe(sha256(content));
    expect(fs.readFileSync(dest)).toEqual(content);
  });

  it('fails with HashMismatchError after exactly one full re-download', async () => {
    const corrupt = Buffer.from('always corrupt', 'utf8');
    const { fetchMock } = makeFetchMock(corrupt);
    global.fetch = fetchMock as unknown as typeof fetch;
    const { dest, part } = paths();

    await expect(
      downloadVerified(
        { url: 'https://s3.test/obj', destAbsPath: dest, partAbsPath: part, contentHash: sha256(content) },
        { api: makeClient(), bucket: new TokenBucket(0) },
      ),
    ).rejects.toThrow(HashMismatchError);

    expect(fetchMock).toHaveBeenCalledTimes(2); // initial + ONE retry
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(part)).toBe(false); // partial cleaned up
  });

  it('maps a 403/AccessDenied response to PresignExpiredError', async () => {
    const { fetchMock } = makeFetchMock(content, [
      () =>
        new Response('<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>', {
          status: 403,
        }),
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;
    const { dest, part } = paths();

    await expect(
      downloadVerified(
        { url: 'https://s3.test/obj', destAbsPath: dest, partAbsPath: part, contentHash: sha256(content) },
        { api: makeClient(), bucket: new TokenBucket(0) },
      ),
    ).rejects.toThrow(PresignExpiredError);

    // 403 is not retryable — a single request only.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('routes chunks through the shared token bucket', async () => {
    const { fetchMock } = makeFetchMock(content);
    global.fetch = fetchMock as unknown as typeof fetch;
    const { dest, part } = paths();

    const taken: number[] = [];
    const bucket = new TokenBucket(0);
    const origTake = bucket.take.bind(bucket);
    bucket.take = async (bytes: number): Promise<void> => {
      taken.push(bytes);
      return origTake(bytes);
    };

    await downloadVerified(
      { url: 'https://s3.test/obj', destAbsPath: dest, partAbsPath: part, contentHash: null },
      { api: makeClient(), bucket },
    );

    expect(taken.reduce((a, b) => a + b, 0)).toBe(content.length);
  });
});

describe('cooldown gate integration (429 brakes the whole engine)', () => {
  const content = Buffer.from('rate limited payload', 'utf8');

  it('trips the shared gate on 429, honors Retry-After, and pauses the next acquire', async () => {
    let t = 0;
    const gateSleeps: number[] = [];
    const trips: number[] = [];
    const gate = new CooldownGate(
      { cooldownMs: 100, maxCooldownMs: 1000 },
      {
        now: () => t,
        sleep: async (ms: number): Promise<void> => {
          gateSleeps.push(ms);
          t += ms;
        },
        onTrip: (ms) => trips.push(ms),
      },
    );

    const { fetchMock } = makeFetchMock(content, [
      (_args, call) =>
        call === 0
          ? new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '2' } })
          : null,
    ]);
    global.fetch = fetchMock as unknown as typeof fetch;

    const { dest, part } = paths();
    const res = await downloadVerified(
      { url: 'https://s3.test/obj', destAbsPath: dest, partAbsPath: part, contentHash: sha256(content) },
      { api: makeClient(gate), bucket: new TokenBucket(0) },
    );

    // Retry-After: 2 → a 2000 ms cooldown window was opened…
    expect(trips).toEqual([2000]);
    // …and the retry's acquire waited the window out before re-requesting.
    expect(gateSleeps).toContain(2000);
    expect(res.sha256).toBe(sha256(content));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
