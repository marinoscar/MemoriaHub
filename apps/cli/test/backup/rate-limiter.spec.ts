/**
 * test/backup/rate-limiter.spec.ts — TokenBucket bandwidth cap (issue #316).
 *
 * Uses an injected fake clock (now/sleep) so the timing assertions are exact
 * and CI-proof: total slept time — not wall time — is the assertion target.
 */

import { TokenBucket } from '../../src/backup/rate-limiter.js';

interface FakeClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  sleeps: number[];
  total: () => number;
}

function makeClock(): FakeClock {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    total: () => sleeps.reduce((a, b) => a + b, 0),
  };
}

describe('TokenBucket', () => {
  it('paces 1 MB at 4 Mbps to ~2 seconds of accumulated sleep', async () => {
    const clock = makeClock();
    const bucket = new TokenBucket(4, { now: clock.now, sleep: clock.sleep });

    // 1 MB in 16 × 64 KiB chunks. 4 Mbps = 500 000 bytes/s.
    const chunk = 64 * 1024;
    for (let i = 0; i < 16; i++) {
      await bucket.take(chunk);
    }

    const expectedMs = (16 * chunk) / 500; // bytes / (bytes per ms) ≈ 2097
    // Generous tolerance: within ±25% of the ideal pacing.
    expect(clock.total()).toBeGreaterThanOrEqual(expectedMs * 0.75);
    expect(clock.total()).toBeLessThanOrEqual(expectedMs * 1.25);
  });

  it('accumulates deficit across concurrent takers (shared across a pool)', async () => {
    const clock = makeClock();
    const bucket = new TokenBucket(8, { now: clock.now, sleep: clock.sleep });

    // Two "workers" each pushing 500 KB concurrently: 1 MB total at 1 MB/s.
    const chunk = 50 * 1000;
    const worker = async (): Promise<void> => {
      for (let i = 0; i < 10; i++) {
        await bucket.take(chunk);
      }
    };
    await Promise.all([worker(), worker()]);

    const expectedMs = (20 * chunk) / 1000; // 1000 bytes/ms at 8 Mbps
    expect(clock.total()).toBeGreaterThanOrEqual(expectedMs * 0.7);
  });

  it('maxMbps 0 disables the cap entirely (no sleeps)', async () => {
    const clock = makeClock();
    const bucket = new TokenBucket(0, { now: clock.now, sleep: clock.sleep });

    expect(bucket.unlimited).toBe(true);
    for (let i = 0; i < 100; i++) {
      await bucket.take(10 * 1024 * 1024);
    }
    expect(clock.sleeps).toHaveLength(0);
  });

  it('refills over elapsed time so idle periods earn a burst allowance', async () => {
    const clock = makeClock();
    const bucket = new TokenBucket(8, { now: clock.now, sleep: clock.sleep });

    await bucket.take(1000); // deficit 1000 → sleeps ~1 ms, balance repaid
    // Idle for 5 s: the balance refills (capped at one second's worth).
    await clock.sleep(5000);
    const sleepsBefore = clock.sleeps.length;
    await bucket.take(1000); // fully covered by the refilled balance
    expect(clock.sleeps.length).toBe(sleepsBefore);
  });
});
