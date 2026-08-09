/**
 * Unit tests for MemoryGenerationHandler (epic #300, issues #302 + #303).
 *
 * Two things are worth asserting here, and both are contracts rather than
 * behavior of any single curator:
 *
 *  1. The QUEUE contract (#302): it self-registers under the right type, it is
 *     server-only (no node-result pair), and a job that reaches the worker while
 *     the feature is disabled SUCCEEDS as a no-op rather than throwing —
 *     throwing would burn retry attempts and light up the admin job dashboard
 *     for a deliberately-off feature.
 *
 *  2. The CURATOR-ISOLATION contract (#303): curators are gated individually by
 *     their own settings toggle, a curator that throws does not abort the run or
 *     fail the job, and its retention tail still runs. This is a stated
 *     acceptance criterion of #303, not defensive programming — a circle with
 *     bad geo data must still get its On This Day memories.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EnrichmentJob } from '@prisma/client';
import { MemoryGenerationHandler } from './memory-generation.handler';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import {
  MEMORY_CURATORS,
  MemoryCurator,
  MemoryCuratorContext,
  MemoryCuratorResult,
} from './curators/memory-curator.interface';
import { MemoryTitleService } from './titles/memory-title.service';
import { MemoriesNotificationService } from './notifications/memories-notification.service';

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'memory_generation',
    mediaItemId: null,
    circleId: 'circle-a',
    payload: null,
    ...overrides,
  } as EnrichmentJob;
}

function result(over: Partial<MemoryCuratorResult> = {}): MemoryCuratorResult {
  return { created: 0, refreshed: 0, skipped: 0, tombstoned: 0, ...over };
}

/** A curator test double whose gate, run and purge are all controllable. */
function fakeCurator(name: string, over: Partial<MemoryCurator> = {}): jest.Mocked<MemoryCurator> {
  return {
    name,
    isEnabled: jest.fn().mockReturnValue(true),
    run: jest.fn().mockResolvedValue(result()),
    purge: jest.fn().mockResolvedValue(0),
    ...over,
  } as unknown as jest.Mocked<MemoryCurator>;
}

describe('MemoryGenerationHandler', () => {
  let handler: MemoryGenerationHandler;
  let registry: EnrichmentHandlerRegistry;
  let settings: { getSettings: jest.Mock };
  let titles: { beginRun: jest.Mock };
  let memoriesNotifications: { recordGeneratedAsync: jest.Mock };
  let curators: MemoryCurator[];

  const originalEnv = process.env['MEMORIES_ENABLED'];

  async function build(withCurators: MemoryCurator[] = []): Promise<void> {
    curators = withCurators;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryGenerationHandler,
        EnrichmentHandlerRegistry,
        { provide: SystemSettingsService, useValue: settings },
        { provide: MemoryTitleService, useValue: titles },
        { provide: MemoriesNotificationService, useValue: memoriesNotifications },
        { provide: MEMORY_CURATORS, useValue: curators },
      ],
    }).compile();

    handler = module.get(MemoryGenerationHandler);
    registry = module.get(EnrichmentHandlerRegistry);
  }

  beforeEach(async () => {
    settings = {
      getSettings: jest.fn().mockResolvedValue({ features: { memories: true } }),
    };
    // The handler only ever OPENS the titling budget (#306); `generate` is
    // reached through MemoryCurationService, which these fake curators replace.
    titles = {
      beginRun: jest.fn((options: { backfill: boolean; aiTitlesEnabled: boolean }) => ({
        ...options,
        maxAiCalls: options.backfill ? 100 : Number.POSITIVE_INFINITY,
        aiCalls: 0,
        stopped: false,
        stopReason: null,
      })),
    };
    memoriesNotifications = { recordGeneratedAsync: jest.fn() };
    delete process.env['MEMORIES_ENABLED'];
    await build();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['MEMORIES_ENABLED'];
    else process.env['MEMORIES_ENABLED'] = originalEnv;
  });

  it('self-registers under type "memory_generation" on module init', () => {
    handler.onModuleInit();

    expect(handler.type).toBe('memory_generation');
    expect(registry.get('memory_generation')).toBe(handler);
  });

  it('is SERVER-ONLY: carries no node-result pair', () => {
    handler.onModuleInit();

    // Viewed through the interface, since the class deliberately declares
    // neither optional member at all.
    const asHandler: EnrichmentHandler = handler;
    expect(asHandler.nodeResultSchema).toBeUndefined();
    expect(asHandler.persistNodeResult).toBeUndefined();
    expect(registry.serverOnlyTypes()).toContain('memory_generation');
  });

  it('succeeds as a no-op when no curators are registered', async () => {
    await expect(handler.process(makeJob())).resolves.toBeUndefined();
  });

  it('succeeds as a no-op when features.memories is off', async () => {
    settings.getSettings.mockResolvedValue({ features: { memories: false } });
    const curator = fakeCurator('on_this_day');
    await build([curator]);

    await expect(handler.process(makeJob())).resolves.toBeUndefined();
    // The gate must short-circuit BEFORE any curator work, not merely discard
    // its output — a disabled feature costs one cached settings read.
    expect(curator.run).not.toHaveBeenCalled();
  });

  it('succeeds as a no-op when MEMORIES_ENABLED=false overrides an enabled flag', async () => {
    process.env['MEMORIES_ENABLED'] = 'false';
    const curator = fakeCurator('on_this_day');
    await build([curator]);

    await expect(handler.process(makeJob())).resolves.toBeUndefined();
    expect(settings.getSettings).toHaveBeenCalled();
    expect(curator.run).not.toHaveBeenCalled();
  });

  it('does not throw on a circle-less job — every memory is circle-scoped', async () => {
    const curator = fakeCurator('on_this_day');
    await build([curator]);

    await expect(handler.process(makeJob({ circleId: null }))).resolves.toBeUndefined();
    expect(curator.run).not.toHaveBeenCalled();
  });

  it('runs every enabled curator and passes one shared context', async () => {
    const a = fakeCurator('a');
    const b = fakeCurator('b');
    await build([a, b]);

    await handler.process(makeJob());

    expect(a.run).toHaveBeenCalledTimes(1);
    expect(b.run).toHaveBeenCalledTimes(1);
    const ctxA = a.run.mock.calls[0]![0];
    const ctxB = b.run.mock.calls[0]![0];
    expect(ctxA.circleId).toBe('circle-a');
    expect(ctxA.backfill).toBe(false);
    // One wall clock for the whole run: a pass straddling midnight must not
    // have curator A anchoring on today and curator B on tomorrow.
    expect(ctxB.now).toBe(ctxA.now);
    // Defaults are resolved for the curators, not left undefined.
    expect(ctxA.settings.onThisDay.lookbackYears).toBe(10);
    expect(ctxA.settings.maxItemsPerMemory).toBe(30);
  });

  it('skips a curator whose per-type toggle is off, but still runs the others', async () => {
    const off = fakeCurator('off', { isEnabled: jest.fn().mockReturnValue(false) });
    const on = fakeCurator('on');
    await build([off, on]);

    await handler.process(makeJob());

    expect(off.run).not.toHaveBeenCalled();
    expect(off.purge).not.toHaveBeenCalled();
    expect(on.run).toHaveBeenCalled();
  });

  it('ISOLATION: a throwing curator does not abort the run or fail the job', async () => {
    const boom = fakeCurator('boom', {
      run: jest.fn().mockRejectedValue(new Error('curator exploded')),
    });
    const healthy = fakeCurator('healthy');
    await build([boom, healthy]);

    await expect(handler.process(makeJob())).resolves.toBeUndefined();

    expect(healthy.run).toHaveBeenCalledTimes(1);
    // The retention tail still runs for the failed curator: its rows are stale
    // regardless of whether this pass produced new ones.
    expect(boom.purge).toHaveBeenCalledTimes(1);
  });

  it('ISOLATION: a throwing purge does not fail the job either', async () => {
    const curator = fakeCurator('leaky', {
      purge: jest.fn().mockRejectedValue(new Error('purge exploded')),
    });
    await build([curator]);

    await expect(handler.process(makeJob())).resolves.toBeUndefined();
    expect(curator.run).toHaveBeenCalled();
  });

  it('tolerates a curator with no purge hook', async () => {
    const curator = fakeCurator('no-tail');
    delete (curator as Partial<MemoryCurator>).purge;
    await build([curator]);

    await expect(handler.process(makeJob())).resolves.toBeUndefined();
  });

  it('propagates payload.backfill into the curator context', async () => {
    const curator = fakeCurator('on_this_day');
    await build([curator]);

    await handler.process(makeJob({ payload: { backfill: true } as never }));

    expect(curator.run.mock.calls[0]![0].backfill).toBe(true);
  });

  // --- #306: the run-wide AI-titling budget ---------------------------------

  it('AI TITLING: opens ONE titling run per job and shares it with every curator', async () => {
    const a = fakeCurator('a');
    const b = fakeCurator('b');
    await build([a, b]);

    await handler.process(makeJob());

    // One budget per job, not one per curator — a provider rate limit must stop
    // titling for the whole run, and a backfill cap must be job-wide.
    expect(titles.beginRun).toHaveBeenCalledTimes(1);
    const runA = (a.run.mock.calls[0]![0] as MemoryCuratorContext).titling;
    const runB = (b.run.mock.calls[0]![0] as MemoryCuratorContext).titling;
    expect(runA).toBeDefined();
    expect(runB).toBe(runA);
  });

  it('AI TITLING: passes the resolved memories.aiTitles.enabled flag through', async () => {
    settings.getSettings.mockResolvedValue({
      features: { memories: true },
      memories: { aiTitles: { enabled: false } },
    });
    const curator = fakeCurator('a');
    await build([curator]);

    await handler.process(makeJob());

    expect(titles.beginRun).toHaveBeenCalledWith({ backfill: false, aiTitlesEnabled: false });
  });

  it('AI TITLING: a backfill job opens a backfill-capped budget', async () => {
    const curator = fakeCurator('a');
    await build([curator]);

    await handler.process(makeJob({ payload: { backfill: true } as never }));

    expect(titles.beginRun).toHaveBeenCalledWith({ backfill: true, aiTitlesEnabled: true });
  });

  // --- #311: the memories_ready notification hook ---------------------------

  it('NOTIFY: fires memories_ready once with the run-wide created total', async () => {
    const a = fakeCurator('a', { run: jest.fn().mockResolvedValue(result({ created: 4 })) });
    const b = fakeCurator('b', { run: jest.fn().mockResolvedValue(result({ created: 2 })) });
    await build([a, b]);

    await handler.process(makeJob());

    // ONE call carrying the summed total — the whole point of the counted-event
    // primitive is that a batch of six memories is one row, not six.
    expect(memoriesNotifications.recordGeneratedAsync).toHaveBeenCalledTimes(1);
    const arg = memoriesNotifications.recordGeneratedAsync.mock.calls[0]![0] as {
      circleId: string;
      createdCount: number;
      since: Date;
    };
    expect(arg.circleId).toBe('circle-a');
    expect(arg.createdCount).toBe(6);
    // `since` is the run's shared wall clock, so the producer's "newest memory
    // of THIS run" lookup sees exactly this pass's rows.
    expect(arg.since).toBe((a.run.mock.calls[0]![0] as MemoryCuratorContext).now);
  });

  it('NOTIFY: a refresh-only run notifies nobody', async () => {
    const curator = fakeCurator('a', {
      run: jest.fn().mockResolvedValue(result({ refreshed: 9, skipped: 3 })),
    });
    await build([curator]);

    await handler.process(makeJob());

    expect(memoriesNotifications.recordGeneratedAsync).not.toHaveBeenCalled();
  });

  it('NOTIFY: a disabled feature never reaches the producer', async () => {
    settings.getSettings.mockResolvedValue({ features: { memories: false } });
    await build([fakeCurator('a', { run: jest.fn().mockResolvedValue(result({ created: 3 })) })]);

    await handler.process(makeJob());

    expect(memoriesNotifications.recordGeneratedAsync).not.toHaveBeenCalled();
  });

  it('NOTIFY: a throwing producer never fails the generation job', async () => {
    memoriesNotifications.recordGeneratedAsync.mockImplementation(() => {
      throw new Error('notification exploded');
    });
    await build([fakeCurator('a', { run: jest.fn().mockResolvedValue(result({ created: 1 })) })]);

    // The producer's public entry point is documented as never throwing, but
    // the handler must not depend on that promise to keep a job green.
    await expect(handler.process(makeJob())).resolves.toBeUndefined();
  });
});
