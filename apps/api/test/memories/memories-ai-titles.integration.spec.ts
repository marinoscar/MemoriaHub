// DB_GATED: requires a real PostgreSQL with migrations applied. Reachability is
// probed synchronously at module load via `describeMaybeDb`, so with no database
// the whole suite is registered as `describe.skip` and reports SKIPPED — never a
// green PASS that asserted nothing. See test/helpers/db-probe.helper.ts.
//
// WHY THIS SUITE IS DB-BACKED (epic #300, issue #306)
// ---------------------------------------------------
// The unit suites next to the service prove that titling produces the right
// VALUES and degrades on every failure. What they cannot prove is the part
// #306's acceptance criteria are actually written about: which of those values
// reaches the `memories` ROW. "`titleSource`/`titleModel` audit which path ran"
// is a statement about five columns, and the interesting cases are all in
// `upsertMemory`'s branching — create writes AI columns, a minor refresh
// PRESERVES them, a material refresh REWRITES them, and a failed call after a
// successful one must clear `titleModel` and `narrative` rather than leaving a
// stale model id attached to a template title.
//
// NO NETWORK: the title service is a stub (test/memories/memory-title.stub.ts).
// This suite is about persistence, not about the provider call.

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { describeMaybeDb } from '../helpers/db-probe.helper';
import { PrismaService } from '../../src/prisma/prisma.service';
import { MemoryCurationService } from '../../src/memories/curation/memory-curation.service';
import { CuratedSelection } from '../../src/memories/curation/memory-curation.types';
import {
  MemoryAiTitle,
  MemoryTitleRequest,
  MemoryTitleRun,
} from '../../src/memories/titles/memory-title.types';
import { stubTitleService } from './memory-title.stub';

function resolveDatabaseUrl(): string {
  if (process.env['DATABASE_URL']) return process.env['DATABASE_URL'] as string;
  const host = process.env['POSTGRES_HOST'] ?? 'localhost';
  const port = process.env['POSTGRES_PORT'] ?? '5432';
  const user = process.env['POSTGRES_USER'] ?? 'postgres';
  const password = process.env['POSTGRES_PASSWORD'] ?? 'postgres';
  const db = process.env['POSTGRES_DB'] ?? 'appdb';
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${db}`;
}

const DATABASE_URL = resolveDatabaseUrl();

const AI_TITLE: MemoryAiTitle = {
  title: 'Five golden days on the Pacific coast',
  subtitle: 'Tamarindo, March 2023',
  narrative: 'Sunsets, surf, and a first swim in the ocean.',
  model: 'gpt-test-1',
};

describeMaybeDb('Memories — AI titles persistence (DB_GATED: real PostgreSQL)', () => {
  let prisma: PrismaClient;

  const userId = randomUUID();
  const circleId = randomUUID();
  const createdStorageObjectIds: string[] = [];

  /** Swapped per test to drive the stubbed title service. */
  let generate: (request: MemoryTitleRequest, run: MemoryTitleRun) => Promise<MemoryAiTitle | null>;
  let seenRequests: MemoryTitleRequest[];
  let curation: MemoryCurationService;

  /** A titling budget with AI enabled — what the handler opens for a real run. */
  function aiRun(): MemoryTitleRun {
    return {
      enabled: true,
      backfill: false,
      maxAiCalls: Number.POSITIVE_INFINITY,
      aiCalls: 0,
      stopped: false,
      stopReason: null,
    };
  }

  async function seedItem(capturedAt: Date): Promise<string> {
    const storageObjectId = randomUUID();
    createdStorageObjectIds.push(storageObjectId);
    await prisma.storageObject.create({
      data: {
        id: storageObjectId,
        name: `${storageObjectId}.jpg`,
        size: BigInt(2048),
        mimeType: 'image/jpeg',
        storageKey: `memories-ai-titles/${storageObjectId}`,
        status: 'ready',
        uploadedById: userId,
      },
    });
    const item = await prisma.mediaItem.create({
      data: {
        storageObjectId,
        circleId,
        addedById: userId,
        type: 'photo',
        source: 'web',
        originalFilename: `${storageObjectId}.jpg`,
        capturedAt,
      },
      select: { id: true },
    });
    return item.id;
  }

  /** A minimal, valid `CuratedSelection` over the supplied item ids. */
  function selectionOf(ids: string[]): CuratedSelection {
    return {
      items: ids.map((mediaItemId, position) => ({ mediaItemId, position, score: 1 })),
      coverMediaItemId: ids[0] ?? null,
      periodStart: new Date(Date.UTC(2023, 2, 4)),
      periodEnd: new Date(Date.UTC(2023, 2, 9)),
      candidateCount: ids.length,
      truncated: false,
    };
  }

  async function upsertTrip(
    ids: string[],
    over: { titling?: MemoryTitleRun; retitle?: boolean } = {},
  ) {
    return curation.upsertMemory({
      circleId,
      type: 'trip',
      periodKey: '2023-03-04',
      subjectKey: 'tamarindo',
      title: 'Trip to Guanacaste',
      subtitle: 'March 2023',
      selection: selectionOf(ids),
      meta: { locality: 'Tamarindo', country: 'Costa Rica' },
      ...over,
    });
  }

  function readMemory() {
    return prisma.memory.findFirstOrThrow({
      where: { circleId },
      select: {
        id: true,
        title: true,
        subtitle: true,
        narrative: true,
        titleSource: true,
        titleModel: true,
      },
    });
  }

  beforeAll(async () => {
    const adapter = new PrismaPg({ connectionString: DATABASE_URL });
    prisma = new PrismaClient({ adapter });
    await prisma.$connect();

    await prisma.user.create({
      data: { id: userId, email: `memories-ai-titles-${userId}@example.test` },
    });
    await prisma.circle.create({
      data: { id: circleId, name: 'Memories AI Titles Circle', ownerId: userId },
    });

    curation = new MemoryCurationService(
      prisma as unknown as PrismaService,
      stubTitleService((request, run) => {
        seenRequests.push(request);
        return generate(request, run);
      }),
    );
  }, 30000);

  afterAll(async () => {
    if (!prisma) return;
    await prisma.memory.deleteMany({ where: { circleId } }).catch(() => undefined);
    await prisma.mediaItem.deleteMany({ where: { circleId } }).catch(() => undefined);
    await prisma.storageObject
      .deleteMany({ where: { id: { in: createdStorageObjectIds } } })
      .catch(() => undefined);
    await prisma.circle.deleteMany({ where: { id: circleId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  }, 30000);

  beforeEach(() => {
    seenRequests = [];
    generate = () => Promise.resolve(AI_TITLE);
  });

  afterEach(async () => {
    await prisma.memory.deleteMany({ where: { circleId } });
  });

  it('AUDIT: a successful call persists the AI title and stamps titleSource/titleModel', async () => {
    const ids = [await seedItem(new Date(Date.UTC(2023, 2, 4)))];

    await upsertTrip(ids, { titling: aiRun() });

    expect(await readMemory()).toMatchObject({
      title: AI_TITLE.title,
      subtitle: AI_TITLE.subtitle,
      narrative: AI_TITLE.narrative,
      titleSource: 'ai',
      titleModel: 'gpt-test-1',
    });
  });

  it('AUDIT: a failed call persists the template and leaves titleModel NULL', async () => {
    generate = () => Promise.resolve(null);
    const ids = [await seedItem(new Date(Date.UTC(2023, 2, 4)))];

    await upsertTrip(ids, { titling: aiRun() });

    expect(await readMemory()).toMatchObject({
      title: 'Trip to Guanacaste',
      subtitle: 'March 2023',
      narrative: null,
      titleSource: 'template',
      titleModel: null,
    });
  });

  it('GRACEFUL DEGRADATION: no titling run at all still writes the memory', async () => {
    // The "no AI provider configured" deployment, from the engine's point of
    // view. Generation must not be blocked, and nothing may be called.
    const ids = [await seedItem(new Date(Date.UTC(2023, 2, 4)))];

    const result = await upsertTrip(ids);

    expect(result.created).toBe(true);
    expect(seenRequests).toHaveLength(0);
    expect(await readMemory()).toMatchObject({ titleSource: 'template', titleModel: null });
  });

  it('sends the curator facts — type, template title, meta and the item ids — to titling', async () => {
    const ids = [await seedItem(new Date(Date.UTC(2023, 2, 4)))];

    await upsertTrip(ids, { titling: aiRun() });

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]).toMatchObject({
      type: 'trip',
      templateTitle: 'Trip to Guanacaste',
      templateSubtitle: 'March 2023',
      meta: { locality: 'Tamarindo', country: 'Costa Rica' },
      mediaItemIds: ids,
    });
  });

  it('ANTI-CHURN: a refresh below the 30% threshold keeps the AI title and makes no call', async () => {
    // Ten items in, one swapped out: Jaccard distance 2/11 ≈ 0.18 < 0.30.
    const base: string[] = [];
    for (let i = 0; i < 10; i += 1) base.push(await seedItem(new Date(Date.UTC(2023, 2, 4, i))));
    await upsertTrip(base, { titling: aiRun() });

    seenRequests = [];
    generate = () => Promise.resolve({ ...AI_TITLE, title: 'A DIFFERENT TITLE' });
    const swapped = [...base.slice(1), await seedItem(new Date(Date.UTC(2023, 2, 9)))];
    const result = await upsertTrip(swapped, { titling: aiRun() });

    expect(result.materiallyChanged).toBe(false);
    // No second model call — this is the rule that stops every generation run
    // from re-paying for a title that is still accurate.
    expect(seenRequests).toHaveLength(0);
    expect(await readMemory()).toMatchObject({
      title: AI_TITLE.title,
      narrative: AI_TITLE.narrative,
      titleSource: 'ai',
      titleModel: 'gpt-test-1',
    });
  });

  it('MATERIAL CHANGE: a >=30% membership change re-titles through AI', async () => {
    const base: string[] = [];
    for (let i = 0; i < 4; i += 1) base.push(await seedItem(new Date(Date.UTC(2023, 2, 4, i))));
    await upsertTrip(base, { titling: aiRun() });

    seenRequests = [];
    generate = () =>
      Promise.resolve({ ...AI_TITLE, title: 'Six golden days', model: 'gpt-test-2' });
    const grown = [...base];
    for (let i = 0; i < 4; i += 1) grown.push(await seedItem(new Date(Date.UTC(2023, 2, 8, i))));
    const result = await upsertTrip(grown, { titling: aiRun() });

    expect(result.materiallyChanged).toBe(true);
    expect(seenRequests).toHaveLength(1);
    expect(await readMemory()).toMatchObject({
      title: 'Six golden days',
      titleSource: 'ai',
      titleModel: 'gpt-test-2',
    });
  });

  it('MATERIAL CHANGE: a failed re-title clears the stale model id and narrative', async () => {
    // The nastiest ordering: an AI-titled memory whose next material refresh
    // cannot reach the provider. Leaving `titleModel`/`narrative` in place would
    // attach a model id and a blurb to a title that model never wrote.
    const base: string[] = [];
    for (let i = 0; i < 4; i += 1) base.push(await seedItem(new Date(Date.UTC(2023, 2, 4, i))));
    await upsertTrip(base, { titling: aiRun() });
    expect(await readMemory()).toMatchObject({ titleSource: 'ai' });

    generate = () => Promise.resolve(null);
    const grown = [...base];
    for (let i = 0; i < 4; i += 1) grown.push(await seedItem(new Date(Date.UTC(2023, 2, 8, i))));
    await upsertTrip(grown, { titling: aiRun() });

    expect(await readMemory()).toMatchObject({
      title: 'Trip to Guanacaste',
      narrative: null,
      titleSource: 'template',
      titleModel: null,
    });
  });

  it('RETITLE: an explicit retitle re-runs AI even on a minor membership change', async () => {
    // The Trips curator's drifted-subject case (#304): the item set barely
    // moved, but the memory is no longer named after the same town.
    const base: string[] = [];
    for (let i = 0; i < 10; i += 1) base.push(await seedItem(new Date(Date.UTC(2023, 2, 4, i))));
    await upsertTrip(base, { titling: aiRun() });

    seenRequests = [];
    generate = () => Promise.resolve({ ...AI_TITLE, title: 'Six days in Nosara' });
    const result = await upsertTrip(base, { titling: aiRun(), retitle: true });

    expect(result.materiallyChanged).toBe(false);
    expect(seenRequests).toHaveLength(1);
    expect(await readMemory()).toMatchObject({ title: 'Six days in Nosara', titleSource: 'ai' });
  });

  it('TOMBSTONE OUTRANKS TITLING: a deleted memory is never re-titled', async () => {
    const ids = [await seedItem(new Date(Date.UTC(2023, 2, 4)))];
    await upsertTrip(ids, { titling: aiRun() });
    const memory = await readMemory();
    await prisma.memory.update({ where: { id: memory.id }, data: { deletedAt: new Date() } });

    seenRequests = [];
    const result = await upsertTrip(ids, { titling: aiRun() });

    expect(result.skippedTombstone).toBe(true);
    // No model call at all: the tombstone check runs BEFORE any titling.
    expect(seenRequests).toHaveLength(0);
  });
});
