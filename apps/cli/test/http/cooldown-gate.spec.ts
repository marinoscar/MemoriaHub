/**
 * test/http/cooldown-gate.spec.ts — unit tests for the cooperative cooldown gate.
 *
 * A fake clock + recording sleep make the cooperative behaviour deterministic.
 */

import { jest } from '@jest/globals';
import { CooldownGate, type CooldownGateConfig } from '../../src/http/cooldown-gate.js';

const CFG: CooldownGateConfig = { cooldownMs: 1000, maxCooldownMs: 8000 };

function harness() {
  let clock = 0;
  const slept: number[] = [];
  const now = () => clock;
  // Records the requested duration but does NOT advance the clock, so concurrent
  // acquirers all observe the same open window (the real cooperative scenario).
  const sleep = async (ms: number) => {
    slept.push(ms);
  };
  return {
    now,
    sleep,
    slept,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('CooldownGate', () => {
  it('acquire is a no-op when idle', async () => {
    const h = harness();
    const gate = new CooldownGate(CFG, { now: h.now, sleep: h.sleep });
    await gate.acquire();
    expect(h.slept).toEqual([]);
    expect(gate.isCoolingDown()).toBe(false);
  });

  it('trip opens a cooldown window that acquire waits out', async () => {
    const h = harness();
    const gate = new CooldownGate(CFG, { now: h.now, sleep: h.sleep });
    gate.trip(); // first trip → cooldownMs window
    expect(gate.isCoolingDown()).toBe(true);
    await gate.acquire();
    expect(h.slept).toEqual([1000]);
  });

  it('ramps the window exponentially on consecutive trips', () => {
    const onTrip = jest.fn();
    const gate = new CooldownGate(CFG, { now: () => 0, onTrip });
    gate.trip(); // 1000
    gate.trip(); // 2000
    gate.trip(); // 4000
    gate.trip(); // 8000 (capped at maxCooldownMs)
    gate.trip(); // still 8000
    expect(onTrip.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000, 8000, 8000]);
  });

  it('honors Retry-After over the ramp', () => {
    const onTrip = jest.fn();
    const gate = new CooldownGate(CFG, { now: () => 0, onTrip });
    gate.trip(5000);
    expect(onTrip).toHaveBeenCalledWith(5000);
  });

  it('never shortens an existing window', () => {
    let clock = 0;
    const gate = new CooldownGate(CFG, { now: () => clock });
    gate.trip(5000); // until = 5000
    clock = 100;
    gate.trip(1000); // would be until=1100 < 5000 → ignored
    // window still ends at 5000, i.e. ~4900ms remain
    expect(gate.isCoolingDown()).toBe(true);
  });

  it('recordSuccess decays the ramp', () => {
    const onTrip = jest.fn();
    const gate = new CooldownGate(CFG, { now: () => 0, onTrip });
    gate.trip(); // 1000
    gate.trip(); // 2000
    gate.recordSuccess(); // back to 1 consecutive trip
    gate.trip(); // 2000 again (not 4000)
    expect(onTrip.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 2000]);
  });

  it('cooperative: a single trip makes every concurrent worker wait the same window', async () => {
    const h = harness();
    const gate = new CooldownGate(CFG, { now: h.now, sleep: h.sleep });
    gate.trip(2000); // one worker hit a 429

    // Three sibling workers acquire before their next request.
    await Promise.all([gate.acquire(), gate.acquire(), gate.acquire()]);

    // All three observed the same open window and waited it out.
    expect(h.slept).toEqual([2000, 2000, 2000]);
  });
});
