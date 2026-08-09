/**
 * Unit tests for MemoryDigestHandler (epic #300, issue #311).
 *
 * The handler is thin on purpose — the send lives in MemoryDigestService — so
 * what is asserted here is its CONTRACT with the enrichment queue, which is
 * where the subtle bugs would be:
 *
 *   - it registers itself, so the type is claimable;
 *   - it is SERVER-ONLY (no node pair), which is what puts it in
 *     serverOnlyTypes() and the ENRICHMENT_WORKER_MODE=system claim set;
 *   - it SUCCEEDS on a partial send (a retry would re-mail everyone the first
 *     pass reached — there is no per-recipient checkpoint);
 *   - it SUCCEEDS on a closed gate (a disabled feature is not a failure);
 *   - it FAILS on an infrastructure error, so the queue retries.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { EnrichmentJob } from '@prisma/client';

import { MemoryDigestHandler } from './memory-digest.handler';
import { MEMORY_DIGEST_JOB_TYPE, MemoryDigestService } from './memory-digest.service';
import { EnrichmentHandler } from '../../enrichment/enrichment-handler.interface';
import { EnrichmentHandlerRegistry } from '../../enrichment/enrichment-handler.registry';

function job(overrides: Partial<EnrichmentJob> = {}): EnrichmentJob {
  return {
    id: 'job-1',
    type: MEMORY_DIGEST_JOB_TYPE,
    circleId: 'circle-1',
    mediaItemId: null,
    payload: null,
    ...overrides,
  } as EnrichmentJob;
}

describe('MemoryDigestHandler', () => {
  let handler: MemoryDigestHandler;
  let digest: { sendForCircle: jest.Mock };
  let registry: { register: jest.Mock };

  beforeEach(async () => {
    digest = {
      sendForCircle: jest.fn().mockResolvedValue({
        candidates: 3,
        recipients: 2,
        sent: 2,
        skippedOptOut: 0,
        skippedEmpty: 0,
        skippedNoEmail: 0,
        failed: 0,
      }),
    };
    registry = { register: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoryDigestHandler,
        { provide: MemoryDigestService, useValue: digest },
        { provide: EnrichmentHandlerRegistry, useValue: registry },
      ],
    }).compile();

    handler = module.get(MemoryDigestHandler);
  });

  it('registers itself under the memory_digest type', () => {
    handler.onModuleInit();

    expect(registry.register).toHaveBeenCalledWith(handler);
    expect(handler.type).toBe('memory_digest');
  });

  it('is SERVER-ONLY — no node compute/persist pair', () => {
    // The absence of this pair is exactly what EnrichmentHandlerRegistry
    // .serverOnlyTypes() infers from; adding one would make the type
    // node-claimable, and a node holds neither the email credential nor the
    // SECRETS_ENCRYPTION_KEY-derived signing key.
    // Typed as EnrichmentHandler so the optional members are addressable — the
    // point of the assertion is that the concrete class does not define them.
    const asHandler: EnrichmentHandler = handler;
    expect(asHandler.nodeResultSchema).toBeUndefined();
    expect(asHandler.persistNodeResult).toBeUndefined();
  });

  it('delegates the send to the service', async () => {
    await handler.process(job());

    expect(digest.sendForCircle).toHaveBeenCalledWith('circle-1');
  });

  it('does nothing for a circle-less job', async () => {
    await expect(handler.process(job({ circleId: null }))).resolves.toBeUndefined();
    expect(digest.sendForCircle).not.toHaveBeenCalled();
  });

  it.each(['gate', 'no_new_content', 'no_circle'])(
    'succeeds as a no-op when the run was skipped (%s)',
    async (reason) => {
      digest.sendForCircle.mockResolvedValue({
        candidates: 0,
        recipients: 0,
        sent: 0,
        skippedOptOut: 0,
        skippedEmpty: 0,
        skippedNoEmail: 0,
        failed: 0,
        skippedReason: reason,
      });

      await expect(handler.process(job())).resolves.toBeUndefined();
    },
  );

  it('SUCCEEDS on a partial send rather than re-mailing everyone on retry', async () => {
    digest.sendForCircle.mockResolvedValue({
      candidates: 3,
      recipients: 5,
      sent: 3,
      skippedOptOut: 0,
      skippedEmpty: 0,
      skippedNoEmail: 0,
      failed: 2,
    });

    await expect(handler.process(job())).resolves.toBeUndefined();
  });

  it('fails the job on an infrastructure error so the queue retries', async () => {
    digest.sendForCircle.mockRejectedValue(new Error('db down'));

    await expect(handler.process(job())).rejects.toThrow('db down');
  });
});
