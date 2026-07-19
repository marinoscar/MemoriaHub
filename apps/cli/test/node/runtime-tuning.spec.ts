/**
 * test/node/runtime-tuning.spec.ts — Unit tests for the pure, deterministic
 * exports of src/node/runtime-tuning.ts (RAM/core-aware worker tuning).
 *
 * Covered:
 *   1. resolveHeapLimitMb — ~50% of RAM rounded down to a 256 MB step, clamped
 *      to [4096, 12288], plus MEMORIAHUB_MAX_OLD_SPACE_MB override semantics.
 *   2. heapNodeFlags — node launch flag construction, including the
 *      MEMORIAHUB_HEAP_SNAPSHOT=0 opt-out and the targetMb<=0 disabled case.
 *   3. resolveSharpConcurrency — half the cores clamped to [1, 4], plus
 *      MEMORIAHUB_SHARP_CONCURRENCY override semantics.
 *   4. resolveDefaultConcurrency — core- and RAM-gated default, clamped to
 *      [2, 4].
 *   5. tunedChildEnv — shallow-copy + sentinel, non-mutating.
 *   6. heapAlreadyTuned — sentinel-set branch only (the live v8 heap-limit
 *      branch is environment-dependent and intentionally not asserted here).
 *   7. maybeReexecWithHeapLimit — always false under Jest (JEST_WORKER_ID
 *      early return), never spawns a child.
 *
 * All functions under test that read process.env are exercised through their
 * explicit-argument overloads (totalBytes/cores/targetMb) so results never
 * depend on the machine actually running the suite. process.env keys touched
 * by any test are snapshotted and restored in beforeEach/afterEach so cases
 * never leak into each other. JEST_WORKER_ID is always set under Jest and is
 * deliberately left alone.
 */

import {
  resolveHeapLimitMb,
  heapNodeFlags,
  resolveSharpConcurrency,
  resolveDefaultConcurrency,
  tunedChildEnv,
  heapAlreadyTuned,
  maybeReexecWithHeapLimit,
} from '../../src/node/runtime-tuning.js';

const GB = 1024 * 1024 * 1024;

const ENV_KEYS = [
  'MEMORIAHUB_MAX_OLD_SPACE_MB',
  'MEMORIAHUB_HEAP_SNAPSHOT',
  'MEMORIAHUB_SHARP_CONCURRENCY',
  'MEMORIAHUB_HEAP_TUNED',
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('resolveHeapLimitMb', () => {
  it('gives ~50% of RAM rounded down to a 256 MB step for a 16 GB machine', () => {
    expect(resolveHeapLimitMb(16 * GB)).toBe(8192);
  });

  it('gives 4096 for an 8 GB machine', () => {
    expect(resolveHeapLimitMb(8 * GB)).toBe(4096);
  });

  it('clamps up to the 4096 MB floor for a 4 GB machine', () => {
    // Raw half (2048) is below HEAP_MIN_MB, so it's clamped up.
    expect(resolveHeapLimitMb(4 * GB)).toBe(4096);
  });

  it('clamps down to the 12288 MB ceiling for a 32 GB machine', () => {
    expect(resolveHeapLimitMb(32 * GB)).toBe(12288);
  });

  it('clamps down to the 12288 MB ceiling for a 64 GB machine', () => {
    expect(resolveHeapLimitMb(64 * GB)).toBe(12288);
  });

  describe('MEMORIAHUB_MAX_OLD_SPACE_MB override', () => {
    it("returns 0 (disabled) when set to '0'", () => {
      process.env['MEMORIAHUB_MAX_OLD_SPACE_MB'] = '0';
      expect(resolveHeapLimitMb(16 * GB)).toBe(0);
    });

    it('returns the override verbatim, ignoring RAM, for a positive integer', () => {
      process.env['MEMORIAHUB_MAX_OLD_SPACE_MB'] = '6000';
      expect(resolveHeapLimitMb(16 * GB)).toBe(6000);
    });

    it('falls back to the computed value when the override is an empty string', () => {
      process.env['MEMORIAHUB_MAX_OLD_SPACE_MB'] = '';
      expect(resolveHeapLimitMb(16 * GB)).toBe(8192);
    });

    it('falls back to the computed value when the override is non-numeric garbage', () => {
      process.env['MEMORIAHUB_MAX_OLD_SPACE_MB'] = 'lots';
      expect(resolveHeapLimitMb(16 * GB)).toBe(8192);
    });

    it('falls back to the computed value when the override is negative', () => {
      process.env['MEMORIAHUB_MAX_OLD_SPACE_MB'] = '-100';
      expect(resolveHeapLimitMb(16 * GB)).toBe(8192);
    });
  });
});

describe('heapNodeFlags', () => {
  it('returns both flags for an explicit positive targetMb', () => {
    expect(heapNodeFlags(8192)).toEqual([
      '--max-old-space-size=8192',
      '--heapsnapshot-near-heap-limit=1',
    ]);
  });

  it('omits the heap-snapshot flag when MEMORIAHUB_HEAP_SNAPSHOT=0', () => {
    process.env['MEMORIAHUB_HEAP_SNAPSHOT'] = '0';
    expect(heapNodeFlags(8192)).toEqual(['--max-old-space-size=8192']);
  });

  it('returns an empty array when targetMb is 0', () => {
    expect(heapNodeFlags(0)).toEqual([]);
  });

  it('returns an empty array when targetMb is negative', () => {
    expect(heapNodeFlags(-1)).toEqual([]);
  });

  it('uses resolveHeapLimitMb() as the default target and includes the snapshot flag', () => {
    const flags = heapNodeFlags();
    expect(flags).toHaveLength(2);
    expect(flags[0]).toMatch(/^--max-old-space-size=\d+$/);
    expect(flags[1]).toBe('--heapsnapshot-near-heap-limit=1');
  });
});

describe('resolveSharpConcurrency', () => {
  it('computes floor(cores/2) clamped to [1,4]', () => {
    expect(resolveSharpConcurrency(8)).toBe(4);
    expect(resolveSharpConcurrency(2)).toBe(1);
    expect(resolveSharpConcurrency(1)).toBe(1);
    expect(resolveSharpConcurrency(16)).toBe(4);
    expect(resolveSharpConcurrency(4)).toBe(2);
  });

  describe('MEMORIAHUB_SHARP_CONCURRENCY override', () => {
    it('uses the override verbatim for a positive integer', () => {
      process.env['MEMORIAHUB_SHARP_CONCURRENCY'] = '6';
      expect(resolveSharpConcurrency(8)).toBe(6);
    });

    it('falls back to the computed value for an invalid override', () => {
      process.env['MEMORIAHUB_SHARP_CONCURRENCY'] = 'nope';
      expect(resolveSharpConcurrency(8)).toBe(4);
    });

    it('falls back to the computed value for an empty override', () => {
      process.env['MEMORIAHUB_SHARP_CONCURRENCY'] = '';
      expect(resolveSharpConcurrency(8)).toBe(4);
    });
  });
});

describe('resolveDefaultConcurrency', () => {
  it('is core-and-RAM gated, clamped to [2,4]', () => {
    expect(resolveDefaultConcurrency(8, 16 * GB)).toBe(4);
    expect(resolveDefaultConcurrency(2, 4 * GB)).toBe(2);
    expect(resolveDefaultConcurrency(16, 64 * GB)).toBe(4);
    // RAM-gated: floor(8/4)=2 beats floor(8 cores /2)=4.
    expect(resolveDefaultConcurrency(8, 8 * GB)).toBe(2);
    // Core-gated: floor(4/2)=2 beats floor(32 GB/4)=8.
    expect(resolveDefaultConcurrency(4, 32 * GB)).toBe(2);
  });
});

describe('tunedChildEnv', () => {
  it('returns a shallow copy of the base env with the tuned sentinel set, without mutating the input', () => {
    const base: NodeJS.ProcessEnv = { FOO: 'bar' };
    const result = tunedChildEnv(base);

    expect(result).toEqual({ FOO: 'bar', MEMORIAHUB_HEAP_TUNED: '1' });
    expect(base).toEqual({ FOO: 'bar' });
    expect(result).not.toBe(base);
  });
});

describe('heapAlreadyTuned', () => {
  it('returns true when the MEMORIAHUB_HEAP_TUNED sentinel is set, regardless of targetMb', () => {
    process.env['MEMORIAHUB_HEAP_TUNED'] = '1';
    expect(heapAlreadyTuned(999_999)).toBe(true);
  });

  // The non-sentinel branch compares against the process's live v8 heap
  // ceiling, which varies by Node build/flags/environment — intentionally
  // not asserted here.
});

describe('maybeReexecWithHeapLimit', () => {
  it('returns false under Jest and never spawns a child (JEST_WORKER_ID early return)', () => {
    expect(process.env['JEST_WORKER_ID']).toBeDefined();
    expect(maybeReexecWithHeapLimit()).toBe(false);
  });
});
