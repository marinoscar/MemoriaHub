// =============================================================================
// Memories — MemoryTitleService test doubles (epic #300, issue #306)
// =============================================================================
//
// `MemoryCurationService` takes a `MemoryTitleService` as of #306. The curator
// integration suites that predate it never pass a `titling` run on their
// contexts, so `upsertMemory` short-circuits to template titles and the service
// is never called — but the constructor still needs an argument.
//
// `neverCalledTitleService()` is that argument, and it is deliberately hostile:
// calling it FAILS the test rather than quietly returning null. A suite that
// starts exercising AI titling by accident should find out immediately, not
// discover it as a mysterious extra query.
// =============================================================================

import { MemoryTitleService } from '../../src/memories/titles/memory-title.service';
import {
  MemoryAiTitle,
  MemoryTitleRequest,
  MemoryTitleRun,
} from '../../src/memories/titles/memory-title.types';

/** A `MemoryTitleService` that throws if anything actually calls it. */
export function neverCalledTitleService(): MemoryTitleService {
  return {
    beginRun(): MemoryTitleRun {
      throw new Error('MemoryTitleService.beginRun was not expected in this suite');
    },
    generate(): Promise<MemoryAiTitle | null> {
      throw new Error('MemoryTitleService.generate was not expected in this suite');
    },
  } as unknown as MemoryTitleService;
}

/**
 * A `MemoryTitleService` whose `generate` is a supplied function — for suites
 * that DO exercise titling but must never reach a real AI provider.
 */
export function stubTitleService(
  generate: (request: MemoryTitleRequest, run: MemoryTitleRun) => Promise<MemoryAiTitle | null>,
): MemoryTitleService {
  return {
    beginRun(options: { backfill: boolean; aiTitlesEnabled: boolean }): MemoryTitleRun {
      return {
        enabled: options.aiTitlesEnabled,
        backfill: options.backfill,
        maxAiCalls: options.backfill ? 100 : Number.POSITIVE_INFINITY,
        aiCalls: 0,
        stopped: false,
        stopReason: null,
      };
    },
    generate,
  } as unknown as MemoryTitleService;
}
