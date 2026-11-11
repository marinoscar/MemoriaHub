import type { MemoriahubConformanceHarness } from '../../testing/index.js';

// =============================================================================
// describeMemoriesSliceConformance (RETRO-J8, #619)
// =============================================================================
//
// The executable proof of the memories slice's job registration. Test-runner neutral.
//
//   types       `memory_generation` and `memory_digest` are registered under exactly these strings
//               (a job type string is permanent once jobs of that type exist).
//   server-only neither declares `nodeResultSchema` or `persistNodeResult`: the generation job needs a
//               model credential and the digest an e-mail credential and a signing key, none of which
//               a worker node may hold.
// =============================================================================

/**
 * What the kit runs against: the handlers the slice registered with the queue.
 *
 * @stability experimental
 */
export interface MemoriesSliceUnderTest {
  /** The registered job handlers (type and optional node members are read). */
  handlers: ReadonlyArray<{
    type: string;
    nodeResultSchema?: unknown;
    persistNodeResult?: unknown;
    profile?: { maxRuntimeMs: number; maxAttempts: number };
  }>;
}

/**
 * Options of {@link describeMemoriesSliceConformance}.
 *
 * @stability experimental
 */
export interface MemoriesSliceConformanceOptions {
  /** The name of the binding under test, shown in the test titles. */
  name: string;
  /** Builds a fresh slice; called before each rule. */
  create(): MemoriesSliceUnderTest | Promise<MemoriesSliceUnderTest>;
}

/**
 * Runs the memories slice conformance rules.
 *
 * @param harness - the test runner's `describe`, `it` and `expect`.
 * @param options - the binding under test.
 * @stability experimental
 */
export function describeMemoriesSliceConformance(
  harness: MemoriahubConformanceHarness,
  options: MemoriesSliceConformanceOptions,
): void {
  const { describe, it, expect } = harness;
  const MEMORY_TYPES = ['memory_digest', 'memory_generation'];

  describe(`memories slice conformance: ${options.name}`, () => {
    it('registers exactly the two memory job types under their permanent strings', async () => {
      const slice = await options.create();
      const types = slice.handlers.map((h) => h.type).filter((t) => t.startsWith('memory_')).sort();
      expect(types).toEqual(MEMORY_TYPES);
    });

    it('keeps both server-only (no node result schema, no node persist)', async () => {
      const slice = await options.create();
      for (const handler of slice.handlers.filter((h) => MEMORY_TYPES.includes(h.type))) {
        expect(handler.nodeResultSchema).toBeUndefined();
        expect(handler.persistNodeResult).toBeUndefined();
      }
    });

    it('declares an execution profile for each', async () => {
      const slice = await options.create();
      const profiles = Object.fromEntries(
        slice.handlers.filter((h) => MEMORY_TYPES.includes(h.type)).map((h) => [h.type, h.profile]),
      );
      expect(profiles).toEqual({
        memory_generation: { maxRuntimeMs: 1_200_000, maxAttempts: 3 },
        memory_digest: { maxRuntimeMs: 900_000, maxAttempts: 2 },
      });
    });
  });
}
