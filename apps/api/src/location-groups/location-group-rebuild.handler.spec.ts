import { EnrichmentJob } from '@prisma/client';
import { EnrichmentHandler } from '../enrichment/enrichment-handler.interface';
import { LocationGroupRebuildHandler } from './location-group-rebuild.handler';

/** One recorded write, so pass ORDER can be asserted. */
interface RecordedWrite {
  pass: 'reset' | 'radius' | 'alias';
  canonical?: string;
  ids?: string[];
}

function makeHandler(opts: {
  groups?: unknown[];
  circles?: { id: string }[];
  bboxCandidates?: { id: string; takenLat: number | null; takenLng: number | null }[];
  distinctRaw?: Record<string, string | null>[];
  settings?: Record<string, unknown>;
  updateManyImpl?: jest.Mock;
}) {
  const writes: RecordedWrite[] = [];

  const executeRaw = jest.fn().mockImplementation(() => {
    writes.push({ pass: 'reset' });
    return Promise.resolve(3);
  });

  // Radius pass paginates; return the candidates once then an empty page.
  let candidatePages = 0;
  const mediaFindMany = jest.fn().mockImplementation(() => {
    if (candidatePages++ === 0) return Promise.resolve(opts.bboxCandidates ?? []);
    return Promise.resolve([]);
  });

  const updateMany =
    opts.updateManyImpl ??
    jest.fn().mockImplementation((args: { where: Record<string, unknown>; data: Record<string, string> }) => {
      const canonical = Object.values(args.data)[0];
      const idFilter = args.where['id'] as { in?: string[] } | undefined;
      writes.push({
        pass: idFilter?.in ? 'radius' : 'alias',
        canonical,
        ids: idFilter?.in,
      });
      return Promise.resolve({ count: 1 });
    });

  let circlePages = 0;
  const prisma = {
    $executeRaw: executeRaw,
    circle: {
      findMany: jest.fn().mockImplementation(() =>
        Promise.resolve(circlePages++ === 0 ? (opts.circles ?? [{ id: 'circle-1' }]) : []),
      ),
    },
    locationGroup: { findMany: jest.fn().mockResolvedValue(opts.groups ?? []) },
    locationGroupAlias: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    mediaItem: {
      findMany: mediaFindMany,
      updateMany,
      groupBy: jest.fn().mockResolvedValue(opts.distinctRaw ?? []),
    },
  } as never;

  const systemSettings = {
    getSettings: jest.fn().mockResolvedValue({
      features: { locationGrouping: true },
      locationGrouping: { radiusCaptureEnabled: true, maxRadiusKm: 50, suggestionMinItems: 1 },
      ...opts.settings,
    }),
  } as never;

  const registry = { register: jest.fn() } as never;

  return {
    handler: new LocationGroupRebuildHandler(registry, prisma, systemSettings),
    prisma: prisma as unknown as {
      $executeRaw: jest.Mock;
      mediaItem: { updateMany: jest.Mock; groupBy: jest.Mock; findMany: jest.Mock };
      locationGroupAlias: { createMany: jest.Mock };
      circle: { findMany: jest.Mock };
    },
    writes,
    registry: registry as unknown as { register: jest.Mock },
  };
}

const job = { id: 'job-1', payload: null } as unknown as EnrichmentJob;

describe('LocationGroupRebuildHandler', () => {
  it('registers itself with the enrichment registry on module init', () => {
    const { handler, registry } = makeHandler({});
    handler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(handler);
  });

  it('is SERVER-ONLY by omission: no node-result pair', () => {
    const { handler } = makeHandler({});
    // Read through the EnrichmentHandler interface: the concrete class does not
    // even DECLARE these members, which is the point — their absence is what
    // EnrichmentHandlerRegistry.serverOnlyTypes() keys off, picking the type up
    // automatically with no explicit pinning.
    const asHandler = handler as EnrichmentHandler;
    expect(asHandler.nodeResultSchema).toBeUndefined();
    expect(asHandler.persistNodeResult).toBeUndefined();
    expect(handler.type).toBe('location_group_rebuild');
  });

  it('resets canonical columns to their raw counterparts, per circle', async () => {
    const { handler, prisma } = makeHandler({ circles: [{ id: 'c1' }, { id: 'c2' }] });
    await handler.process(job);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('scopes the reset to one circle when payload.circleId is given', async () => {
    const { handler, prisma } = makeHandler({});
    await handler.process({ id: 'j', payload: { circleId: 'c9' } } as unknown as EnrichmentJob);

    expect(prisma.circle.findMany).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Pass ordering — the load-bearing property.
  // ---------------------------------------------------------------------------

  it('runs passes in RESET → RADIUS → ALIAS order, so an alias OVERRIDES a radius claim', async () => {
    const { handler, writes } = makeHandler({
      groups: [
        {
          id: 'g1',
          level: 'locality',
          countryCode: 'US',
          canonicalName: 'The Woodlands',
          centerLat: 30.16,
          centerLng: -95.46,
          radiusKm: 8,
          aliases: [{ id: 'a1', normalizedValue: 'sterling ridge', rawValue: 'Sterling Ridge' }],
        },
      ],
      bboxCandidates: [{ id: 'm1', takenLat: 30.16, takenLng: -95.46 }],
    });

    await handler.process(job);

    const order = writes.map((w) => w.pass);
    expect(order[0]).toBe('reset');
    expect(order.indexOf('radius')).toBeGreaterThan(-1);
    expect(order.indexOf('alias')).toBeGreaterThan(order.indexOf('radius'));
  });

  it('claims only bbox candidates that pass the exact haversine refinement', async () => {
    const { handler, writes } = makeHandler({
      groups: [
        {
          id: 'g1',
          level: 'locality',
          countryCode: 'US',
          canonicalName: 'The Woodlands',
          centerLat: 30.16,
          centerLng: -95.46,
          radiusKm: 5,
          aliases: [],
        },
      ],
      bboxCandidates: [
        { id: 'inside', takenLat: 30.16, takenLng: -95.46 },
        // A bbox CORNER — inside the square, outside the circle.
        { id: 'corner', takenLat: 30.2, takenLng: -95.41 },
      ],
    });

    await handler.process(job);

    const radiusWrite = writes.find((w) => w.pass === 'radius');
    expect(radiusWrite?.ids).toEqual(['inside']);
    expect(radiusWrite?.ids).not.toContain('corner');
  });

  it('skips the radius pass entirely when radiusCaptureEnabled is false', async () => {
    const { handler, writes } = makeHandler({
      groups: [
        {
          id: 'g1',
          level: 'locality',
          countryCode: 'US',
          canonicalName: 'The Woodlands',
          centerLat: 30.16,
          centerLng: -95.46,
          radiusKm: 8,
          aliases: [],
        },
      ],
      bboxCandidates: [{ id: 'm1', takenLat: 30.16, takenLng: -95.46 }],
      settings: {
        locationGrouping: { radiusCaptureEnabled: false, maxRadiusKm: 50, suggestionMinItems: 1 },
      },
    });

    await handler.process(job);
    expect(writes.some((w) => w.pass === 'radius')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Self-healing sweep
  // ---------------------------------------------------------------------------

  it('claims a case/accent variant the admin never listed and PERSISTS it as an alias', async () => {
    const { handler, prisma } = makeHandler({
      groups: [
        {
          id: 'g1',
          level: 'locality',
          countryCode: 'CR',
          canonicalName: 'San José',
          centerLat: null,
          centerLng: null,
          radiusKm: null,
          aliases: [{ id: 'a1', normalizedValue: 'san jose', rawValue: 'San Jose' }],
        },
      ],
      // "SAN JOSE" folds to 'san jose' but its exact bytes are not in the in: list.
      distinctRaw: [{ geoLocality: 'SAN JOSE' }, { geoLocality: 'Cartago' }],
    });

    await handler.process(job);

    expect(prisma.locationGroupAlias.createMany).toHaveBeenCalledTimes(1);
    const created = prisma.locationGroupAlias.createMany.mock.calls[0][0];
    expect(created.data[0]).toMatchObject({
      groupId: 'g1',
      rawValue: 'SAN JOSE',
      normalizedValue: 'san jose',
    });
    // skipDuplicates keeps a concurrent rebuild (or a fold owned by another
    // group under the unique index) from failing the whole pass.
    expect(created.skipDuplicates).toBe(true);
  });

  it('does NOT heal a raw value whose fold belongs to no alias of this group', async () => {
    const { handler, prisma } = makeHandler({
      groups: [
        {
          id: 'g1',
          level: 'locality',
          countryCode: 'CR',
          canonicalName: 'San José',
          centerLat: null,
          centerLng: null,
          radiusKm: null,
          aliases: [{ id: 'a1', normalizedValue: 'san jose', rawValue: 'San Jose' }],
        },
      ],
      distinctRaw: [{ geoLocality: 'San Juan' }],
    });

    await handler.process(job);
    expect(prisma.locationGroupAlias.createMany).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Failure isolation
  // ---------------------------------------------------------------------------

  it('COUNTS a per-group failure instead of aborting the whole run', async () => {
    let call = 0;
    const updateManyImpl = jest.fn().mockImplementation(() => {
      call++;
      // Fail the FIRST group's alias updateMany only.
      if (call === 1) return Promise.reject(new Error('boom'));
      return Promise.resolve({ count: 1 });
    });

    const { handler, prisma } = makeHandler({
      groups: [
        {
          id: 'bad',
          level: 'locality',
          countryCode: '',
          canonicalName: 'Bad Group',
          centerLat: null,
          centerLng: null,
          radiusKm: null,
          aliases: [{ id: 'a1', normalizedValue: 'x', rawValue: 'X' }],
        },
        {
          id: 'good',
          level: 'locality',
          countryCode: '',
          canonicalName: 'Good Group',
          centerLat: null,
          centerLng: null,
          radiusKm: null,
          aliases: [{ id: 'a2', normalizedValue: 'y', rawValue: 'Y' }],
        },
      ],
      updateManyImpl,
    });

    // Must not throw — a bad group cannot strand every other group.
    await expect(handler.process(job)).resolves.toBeUndefined();

    // The second (good) group was still processed after the first threw.
    expect(prisma.mediaItem.updateMany).toHaveBeenCalledTimes(2);
  });

  it('a radius-pass failure is also counted, not fatal', async () => {
    const updateManyImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error('radius boom'))
      .mockResolvedValue({ count: 0 });

    const { handler } = makeHandler({
      groups: [
        {
          id: 'g1',
          level: 'locality',
          countryCode: '',
          canonicalName: 'Group',
          centerLat: 30,
          centerLng: -95,
          radiusKm: 8,
          aliases: [],
        },
      ],
      bboxCandidates: [{ id: 'm1', takenLat: 30, takenLng: -95 }],
      updateManyImpl,
    });

    await expect(handler.process(job)).resolves.toBeUndefined();
  });

  it('is NOT feature-gated: with grouping OFF the reset pass still runs (that is how disabling takes effect)', async () => {
    const { handler, prisma } = makeHandler({
      settings: { features: { locationGrouping: false } },
    });

    await handler.process(job);
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });
});
