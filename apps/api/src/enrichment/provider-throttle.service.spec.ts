/**
 * Unit tests for ProviderThrottleService.
 *
 * Uses injectable fake now/sleep hooks so tests are fully deterministic and
 * do not call real timers. BASE_MS = 2_000, MAX_MS = 60_000.
 */

import { ProviderThrottleService } from './provider-throttle.service';

// Convenience constant for the hard-coded values in the implementation
const BASE_MS = 2_000;
const MAX_MS = 60_000;

/** Builds a ProviderThrottleService with a fake clock fixed at fakeNow[0]. */
function makeService(fakeNow: { value: number }) {
  const sleepLog: number[] = [];
  const svc = new ProviderThrottleService({
    now: () => fakeNow.value,
    sleep: async (ms: number) => {
      sleepLog.push(ms);
    },
  });
  return { svc, sleepLog };
}

describe('ProviderThrottleService', () => {
  // -------------------------------------------------------------------------
  // acquire — no-op when gate has never been tripped
  // -------------------------------------------------------------------------

  describe('acquire on a key that has never been tripped', () => {
    it('does not sleep — the gate does not exist yet', async () => {
      const now = { value: 1000 };
      const { svc, sleepLog } = makeService(now);

      await svc.acquire('new-key');

      expect(sleepLog).toHaveLength(0);
    });

    it('resolves immediately without error', async () => {
      const now = { value: 0 };
      const { svc } = makeService(now);

      await expect(svc.acquire('untripped')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // trip → isCoolingDown → acquire
  // -------------------------------------------------------------------------

  describe('after trip: isCoolingDown is true and acquire sleeps the remaining window', () => {
    it('isCoolingDown is false before first trip', () => {
      const now = { value: 0 };
      const { svc } = makeService(now);

      expect(svc.isCoolingDown('tagging')).toBe(false);
    });

    it('isCoolingDown is true immediately after trip', () => {
      const now = { value: 0 };
      const { svc } = makeService(now);

      svc.trip('tagging');

      expect(svc.isCoolingDown('tagging')).toBe(true);
    });

    it('acquire sleeps the remaining cooldown after a trip (first trip = BASE_MS)', async () => {
      const now = { value: 0 };
      const { svc, sleepLog } = makeService(now);

      svc.trip('tagging'); // cooldownUntil = 0 + 2000
      await svc.acquire('tagging');

      expect(sleepLog).toEqual([BASE_MS]); // remaining = 2000 - 0 = 2000
    });

    it('acquire sleeps exactly the remaining duration when called mid-window', async () => {
      const now = { value: 0 };
      const { svc, sleepLog } = makeService(now);

      svc.trip('tagging'); // cooldownUntil = 2000
      now.value = 500; // advance clock
      await svc.acquire('tagging');

      expect(sleepLog).toEqual([1500]); // remaining = 2000 - 500 = 1500
    });

    it('acquire does NOT sleep once the window has expired', async () => {
      const now = { value: 0 };
      const { svc, sleepLog } = makeService(now);

      svc.trip('tagging'); // cooldownUntil = 2000
      now.value = 3000; // past the window
      await svc.acquire('tagging');

      expect(sleepLog).toHaveLength(0);
    });

    it('isCoolingDown is false once the window has expired', () => {
      const now = { value: 0 };
      const { svc } = makeService(now);

      svc.trip('tagging');
      now.value = 3000;

      expect(svc.isCoolingDown('tagging')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Different keys are independent
  // -------------------------------------------------------------------------

  describe('keys are independent', () => {
    it('a trip on "tagging" does not affect "geocode"', async () => {
      const now = { value: 0 };
      const { svc, sleepLog } = makeService(now);

      svc.trip('tagging');
      await svc.acquire('geocode');

      expect(sleepLog).toHaveLength(0);
    });

    it('tripping both keys causes acquire to sleep for each independently', async () => {
      const now = { value: 0 };
      const { svc, sleepLog } = makeService(now);

      svc.trip('tagging'); // cooldownUntil = 2000
      svc.trip('geocode'); // cooldownUntil = 2000 (same, first trip each)

      await svc.acquire('tagging');
      await svc.acquire('geocode');

      expect(sleepLog).toHaveLength(2);
      expect(sleepLog).toEqual([BASE_MS, BASE_MS]);
    });
  });

  // -------------------------------------------------------------------------
  // Explicit retryAfterMs
  // -------------------------------------------------------------------------

  describe('explicit retryAfterMs overrides the exponential ramp', () => {
    it('cooldownUntil = now + retryAfterMs when retryAfterMs is provided', async () => {
      const now = { value: 0 };
      const { svc, sleepLog } = makeService(now);

      svc.trip('tagging', 10_000);
      await svc.acquire('tagging');

      expect(sleepLog).toEqual([10_000]);
    });

    it('retryAfterMs of 0 does not sleep', async () => {
      const now = { value: 0 };
      const { svc, sleepLog } = makeService(now);

      svc.trip('tagging', 0); // until = 0 + 0 = 0; remaining = 0 - 0 = 0; no sleep
      await svc.acquire('tagging');

      expect(sleepLog).toHaveLength(0);
    });

    it('never shortens an existing larger window', async () => {
      const now = { value: 0 };
      const { svc, sleepLog } = makeService(now);

      svc.trip('tagging', 10_000); // cooldownUntil = 10_000
      svc.trip('tagging', 100);   // would be 100, but existing 10_000 > 0+100

      await svc.acquire('tagging');

      // 10_000 - 0 = 10_000 (the shorter window did NOT truncate it)
      expect(sleepLog).toEqual([10_000]);
    });
  });

  // -------------------------------------------------------------------------
  // Exponential ramp (consecutive trips, no retryAfterMs)
  // -------------------------------------------------------------------------

  describe('consecutive trips ramp exponentially', () => {
    it('trip 1 → window = BASE_MS (2000)', async () => {
      const now = { value: 0 };
      const { svc, sleepLog } = makeService(now);

      svc.trip('tagging');
      await svc.acquire('tagging');

      expect(sleepLog).toEqual([2_000]);
    });

    it('trip 2 → window = BASE_MS * 2 (4000)', async () => {
      const now = { value: 0 };
      const { svc, sleepLog } = makeService(now);

      svc.trip('tagging'); // trip 1: cooldownUntil=2000, consecutiveTrips=1
      svc.trip('tagging'); // trip 2: ramp=4000, until=4000 > 2000 → cooldownUntil=4000

      await svc.acquire('tagging');

      expect(sleepLog).toEqual([4_000]);
    });

    it('trip 3 → window = BASE_MS * 4 (8000)', async () => {
      const now = { value: 0 };
      const { svc, sleepLog } = makeService(now);

      svc.trip('tagging');
      svc.trip('tagging');
      svc.trip('tagging'); // consecutiveTrips=3, ramp = 2000*4 = 8000

      await svc.acquire('tagging');

      expect(sleepLog).toEqual([8_000]);
    });

    it('ramp is capped at MAX_MS (60000) on many consecutive trips', async () => {
      const now = { value: 0 };
      const { svc, sleepLog } = makeService(now);

      // 6 trips: 2^5 * 2000 = 64000; min(60000, 64000) = 60000
      for (let i = 0; i < 6; i++) svc.trip('tagging');

      // Advance now past intermediate windows so acquire only sleeps the final cap
      now.value = 0;
      await svc.acquire('tagging');

      expect(sleepLog[0]).toBe(MAX_MS);
    });

    it('gate stores the highest cooldownUntil across trips (never shortened)', () => {
      const now = { value: 0 };
      const { svc } = makeService(now);

      svc.trip('tagging'); // trip 1: until=2000
      svc.trip('tagging'); // trip 2: until=4000 > 2000 → 4000

      const gate = svc._gates.get('tagging')!;
      expect(gate.cooldownUntil).toBe(4_000);
    });
  });

  // -------------------------------------------------------------------------
  // recordSuccess decays the ramp
  // -------------------------------------------------------------------------

  describe('recordSuccess decays consecutiveTrips', () => {
    it('decrements consecutiveTrips by 1', () => {
      const now = { value: 0 };
      const { svc } = makeService(now);

      svc.trip('tagging');
      svc.trip('tagging'); // consecutiveTrips=2

      svc.recordSuccess('tagging');

      const gate = svc._gates.get('tagging')!;
      expect(gate.consecutiveTrips).toBe(1);
    });

    it('does not go below 0', () => {
      const now = { value: 0 };
      const { svc } = makeService(now);

      svc.trip('tagging'); // consecutiveTrips=1
      svc.recordSuccess('tagging');
      svc.recordSuccess('tagging'); // extra call — should not go negative

      const gate = svc._gates.get('tagging')!;
      expect(gate.consecutiveTrips).toBe(0);
    });

    it('is a no-op for a key that has never been tripped', () => {
      const now = { value: 0 };
      const { svc } = makeService(now);

      expect(() => svc.recordSuccess('phantom-key')).not.toThrow();
    });

    it('reduced ramp: after 2 trips + 1 success, next trip uses ramp for trips=2', async () => {
      const now = { value: 0 };
      const { svc, sleepLog } = makeService(now);

      svc.trip('tagging'); // consecutiveTrips=1
      svc.trip('tagging'); // consecutiveTrips=2
      svc.recordSuccess('tagging'); // consecutiveTrips=1

      // Advance past existing cooldown window so the next trip extends it
      now.value = 100_000;
      svc.trip('tagging'); // consecutiveTrips=2 again; ramp=4000; until=104000

      await svc.acquire('tagging');

      expect(sleepLog).toEqual([4_000]); // ramp for 2 trips
    });
  });

  // -------------------------------------------------------------------------
  // _gates is exposed for test inspection
  // -------------------------------------------------------------------------

  describe('_gates map', () => {
    it('is empty before any operations', () => {
      const now = { value: 0 };
      const { svc } = makeService(now);

      expect(svc._gates.size).toBe(0);
    });

    it('is populated only after trip (not after acquire)', async () => {
      const now = { value: 0 };
      const { svc } = makeService(now);

      await svc.acquire('tagging'); // no gate created
      expect(svc._gates.size).toBe(0);

      svc.trip('tagging');
      expect(svc._gates.size).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // resolveKey — static method
  // -------------------------------------------------------------------------

  describe('resolveKey', () => {
    it('maps "auto_tagging" → "tagging"', () => {
      expect(ProviderThrottleService.resolveKey('auto_tagging')).toBe('tagging');
    });

    it('maps "geocode" → "geocode"', () => {
      expect(ProviderThrottleService.resolveKey('geocode')).toBe('geocode');
    });

    it('maps "face_detection" → "face"', () => {
      expect(ProviderThrottleService.resolveKey('face_detection')).toBe('face');
    });

    it('returns null for "storage_migration"', () => {
      expect(ProviderThrottleService.resolveKey('storage_migration')).toBeNull();
    });

    it('returns null for "storage_insights"', () => {
      expect(ProviderThrottleService.resolveKey('storage_insights')).toBeNull();
    });

    it('returns null for "trash_purge"', () => {
      expect(ProviderThrottleService.resolveKey('trash_purge')).toBeNull();
    });

    it('returns null for "metadata_extraction"', () => {
      expect(ProviderThrottleService.resolveKey('metadata_extraction')).toBeNull();
    });

    it('returns null for "burst_detection"', () => {
      expect(ProviderThrottleService.resolveKey('burst_detection')).toBeNull();
    });

    it('returns null for an unknown job type', () => {
      expect(ProviderThrottleService.resolveKey('some_unknown_type')).toBeNull();
    });
  });
});
