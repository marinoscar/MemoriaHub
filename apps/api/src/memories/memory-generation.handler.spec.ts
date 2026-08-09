/**
 * Unit tests for MemoryGenerationHandler (epic #300, issue #302).
 *
 * The v1 handler is a deliberate no-op, so what is actually worth asserting is
 * its CONTRACT with the queue: it self-registers under the right type, it is
 * server-only (no node-result pair), and a job that reaches the worker while
 * the feature is disabled SUCCEEDS as a no-op rather than throwing — throwing
 * would burn retry attempts and light up the admin job dashboard for a
 * deliberately-off feature.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EnrichmentJob } from '@prisma/client';
import { MemoryGenerationHandler } from './memory-generation.handler';
import { EnrichmentHandlerRegistry } from '../enrichment/enrichment-handler.registry';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';

function makeJob(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: 'memory_generation',
    mediaItemId: null,
    circleId: 'circle-a',
    ...overrides,
  } as EnrichmentJob;
}

describe('MemoryGenerationHandler', () => {
  let handler: MemoryGenerationHandler;
  let registry: EnrichmentHandlerRegistry;
  let settings: { getSettings: jest.Mock };

  const originalEnv = process.env['MEMORIES_ENABLED'];

  beforeEach(async () => {
    settings = {
      getSettings: jest.fn().mockResolvedValue({ features: { memories: true } }),
    };
    delete process.env['MEMORIES_ENABLED'];

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryGenerationHandler,
        EnrichmentHandlerRegistry,
        { provide: SystemSettingsService, useValue: settings },
      ],
    }).compile();

    handler = module.get(MemoryGenerationHandler);
    registry = module.get(EnrichmentHandlerRegistry);
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

  it('succeeds as a no-op when the feature is enabled (no curators yet)', async () => {
    await expect(handler.process(makeJob())).resolves.toBeUndefined();
  });

  it('succeeds as a no-op when features.memories is off', async () => {
    settings.getSettings.mockResolvedValue({ features: { memories: false } });

    await expect(handler.process(makeJob())).resolves.toBeUndefined();
  });

  it('succeeds as a no-op when MEMORIES_ENABLED=false overrides an enabled flag', async () => {
    process.env['MEMORIES_ENABLED'] = 'false';

    await expect(handler.process(makeJob())).resolves.toBeUndefined();
    expect(settings.getSettings).toHaveBeenCalled();
  });

  it('does not throw on a circle-less job — every memory is circle-scoped', async () => {
    await expect(handler.process(makeJob({ circleId: null }))).resolves.toBeUndefined();
  });
});
