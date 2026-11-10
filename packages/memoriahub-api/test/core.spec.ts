import 'reflect-metadata';

import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import {
  MemoriahubAiError,
  MemoriahubRateLimitError,
  MEMORIAHUB_CLASSIFY_RATE_LIMIT,
  MEMORIAHUB_JOBS,
  MEMORIAHUB_METRICS,
  MEMORIAHUB_AUDIT,
  MEMORIAHUB_WEBHOOKS,
  MEMORIAHUB_EVENTS,
  type MemoriahubJobsPort,
} from '../src/ports/index.js';
import {
  MemoriahubFeatureDisabledError,
  MemoriahubPortsModule,
  NOOP_MEMORIAHUB_AUDIT,
  Prisma,
  aiRateLimit,
  asJobError,
  isFeatureEnabled,
} from '../src/core/index.js';
import { FakeMemoriahubSettings, createFakeMemoriahubPorts, fakeMemoriahubBindings } from '../src/testing/index.js';

describe('MemoriahubPortsModule.forRoot', () => {
  it('names every missing required port', () => {
    expect(() => MemoriahubPortsModule.forRoot({ ports: {} as never })).toThrow(/MEMORIAHUB_PRISMA.*MEMORIAHUB_JOBS/s);
    const { jobs, ...rest } = fakeMemoriahubBindings();
    void jobs;
    expect(() => MemoriahubPortsModule.forRoot({ ports: rest as never })).toThrow(/no binding for port MEMORIAHUB_JOBS/);
  });

  it('provides every token globally, and defaults the optional ports', async () => {
    @Injectable()
    class Slice {
      constructor(@Inject(MEMORIAHUB_JOBS) readonly jobs: MemoriahubJobsPort) {}
    }
    @Module({ providers: [Slice] })
    class SliceModule {}

    const { audit, webhooks, metrics, events, ...required } = fakeMemoriahubBindings();
    void audit; void webhooks; void metrics; void events;
    const fakes = createFakeMemoriahubPorts();
    const moduleRef = await Test.createTestingModule({
      imports: [MemoriahubPortsModule.forRoot({ ports: { ...fakeMemoriahubBindings(fakes), ...required, jobs: { useValue: fakes.jobs } } }), SliceModule],
    }).compile();

    expect(moduleRef.get(Slice).jobs).toBe(fakes.jobs);
    expect(moduleRef.get(MEMORIAHUB_JOBS)).toBe(fakes.jobs);
    await moduleRef.close();

    const defaults = await Test.createTestingModule({
      imports: [MemoriahubPortsModule.forRoot({ ports: required as never })],
    }).compile();
    expect(defaults.get(MEMORIAHUB_AUDIT)).toBe(NOOP_MEMORIAHUB_AUDIT);
    await expect(defaults.get(MEMORIAHUB_WEBHOOKS).emit('x', {}, { orgId: null })).resolves.toBeUndefined();
    expect(() => defaults.get(MEMORIAHUB_METRICS).add('x')).not.toThrow();
    const received: unknown[] = [];
    defaults.get(MEMORIAHUB_EVENTS).subscribe('a.b', (payload: unknown) => { received.push(payload); });
    defaults.get(MEMORIAHUB_EVENTS).emit('a.b', 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(received).toEqual([1]);
    await defaults.close();
  });
});

describe('core helpers', () => {
  it('isFeatureEnabled reads the features namespace and honours the kill switch', async () => {
    const settings = new FakeMemoriahubSettings();
    settings.registerNamespace({ scope: 'system', name: 'features', schema: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never, defaults: { memories: true, workflows: false } });
    expect(await isFeatureEnabled(settings, 'memories')).toBe(true);
    expect(await isFeatureEnabled(settings, 'workflows')).toBe(false);
    expect(await isFeatureEnabled(settings, 'unknownFlag')).toBe(false);
    process.env['CONFORMANCE_KILL'] = 'false';
    expect(await isFeatureEnabled(settings, 'memories', 'CONFORMANCE_KILL')).toBe(false);
    delete process.env['CONFORMANCE_KILL'];
    expect(await isFeatureEnabled(settings, 'memories', 'CONFORMANCE_KILL')).toBe(true);
  });

  it('turns an AI rate limit into the job deferral error and leaves other errors alone', () => {
    const limited = new MemoriahubAiError('rate_limit', 'slow down', 1500);
    const error = asJobError(limited, 'tagging');
    expect(error).toBeInstanceOf(MemoriahubRateLimitError);
    expect((error as MemoriahubRateLimitError).throttleKey).toBe('tagging');
    expect((error as MemoriahubRateLimitError).retryAfterMs).toBe(1500);
    expect((error as MemoriahubRateLimitError)[MEMORIAHUB_CLASSIFY_RATE_LIMIT]()).toEqual({ rateLimited: true, retryAfterMs: 1500 });
    const other = new MemoriahubAiError('auth', 'refused');
    expect(asJobError(other)).toBe(other);
    expect(aiRateLimit(new Error('x'))).toBeNull();
  });

  it('carries a reason under details, never at the top level', () => {
    const error = new MemoriahubFeatureDisabledError('pictureEnhancement');
    expect(error.reason).toBe('FEATURE_DISABLED');
    expect(error.details).toEqual({ feature: 'pictureEnhancement' });
  });

  it('builds SQL through the optional runtime-utils peer', () => {
    const sql = Prisma.sql`SELECT ${1}::int`;
    expect(sql.values).toEqual([1]);
    expect(Prisma.join([1, 2]).values).toEqual([1, 2]);
  });
});
