import type { MemoriahubConformanceHarness } from '../../testing/index.js';
import type { MemoriahubJobHandler } from '../../ports/index.js';

// =============================================================================
// describeEnhancementSliceConformance (RETRO-J10, #624)
// =============================================================================
//
// The executable proof of the enhancement slice's queue contract. Test-runner neutral.
//
//   registration   `picture_enhancement` and `picture_enhancement_purge` register through the jobs port.
//   server-only    `picture_enhancement` calls a model, so it declares `usesAi` and never the node result
//                  pair (a provider key is never brokered to a worker node); its profile is unchanged.
//   cron           the hourly purge cron only enqueues the housekeeping job, and only on an instance whose
//                  host says it is a worker.
// =============================================================================

/**
 * What the kit runs against.
 *
 * @stability experimental
 */
export interface EnhancementSliceUnderTest {
  /** The enhancement and the purge handlers. */
  handlers: MemoriahubJobHandler[];
  /** Whether the jobs port holds a handler for the type (after the module initialised). */
  registered(type: string): boolean;
  /** Fires the purge cron once. */
  runPurgeCron(): Promise<void>;
  /** The housekeeping job types enqueued so far. */
  housekeepingEnqueued(): string[] | Promise<string[]>;
  /** Says whether this instance schedules the sweep (the host's `housekeepingEnabled`). */
  setHousekeepingEnabled(enabled: boolean): void | Promise<void>;
}

/**
 * Options of {@link describeEnhancementSliceConformance}.
 *
 * @stability experimental
 */
export interface EnhancementSliceConformanceOptions {
  /** The name of the binding under test, shown in the test titles. */
  name: string;
  /** Builds a fresh slice; called before each rule. */
  create(): EnhancementSliceUnderTest | Promise<EnhancementSliceUnderTest>;
}

/**
 * Runs the enhancement slice conformance rules.
 *
 * @param harness - the test runner's `describe`, `it` and `expect`.
 * @param options - the binding under test.
 * @stability experimental
 */
export function describeEnhancementSliceConformance(
  harness: MemoriahubConformanceHarness,
  options: EnhancementSliceConformanceOptions,
): void {
  const { describe, it, expect } = harness;

  describe(`enhancement slice conformance: ${options.name}`, () => {
    it('registers both job types through the jobs port', async () => {
      const slice = await options.create();

      expect(slice.registered('picture_enhancement')).toBe(true);
      expect(slice.registered('picture_enhancement_purge')).toBe(true);
    });

    it('keeps picture_enhancement server-only: usesAi, no node result pair, the permanent profile', async () => {
      const slice = await options.create();
      const handler = slice.handlers.find((candidate) => candidate.type === 'picture_enhancement');

      expect(handler).toBeDefined();
      expect(handler?.usesAi).toBe(true);
      expect(handler?.nodeResultSchema).toBeUndefined();
      expect(handler?.persistNodeResult).toBeUndefined();
      expect(handler?.profile).toEqual({ maxRuntimeMs: 600_000, maxAttempts: 3 });
      expect(handler?.throttleKey).toBe('enhance');
    });

    it('keeps the purge a plain housekeeping job (no AI, no node pair)', async () => {
      const slice = await options.create();
      const handler = slice.handlers.find((candidate) => candidate.type === 'picture_enhancement_purge');

      expect(handler?.usesAi).toBeUndefined();
      expect(handler?.nodeResultSchema).toBeUndefined();
      expect(handler?.profile).toEqual({ maxRuntimeMs: 600_000, maxAttempts: 2 });
    });

    it('enqueues only the housekeeping job from the cron, on a worker instance', async () => {
      const slice = await options.create();
      await slice.setHousekeepingEnabled(true);

      await slice.runPurgeCron();

      expect(await slice.housekeepingEnqueued()).toEqual(['picture_enhancement_purge']);
    });

    it('schedules nothing on an instance with no worker', async () => {
      const slice = await options.create();
      await slice.setHousekeepingEnabled(false);

      await slice.runPurgeCron();

      expect(await slice.housekeepingEnqueued()).toEqual([]);
    });
  });
}
