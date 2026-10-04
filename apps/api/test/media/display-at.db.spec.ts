/**
 * Real-Postgres tier (issue #549): proves the STORED GENERATED column
 * `media_items.display_at = COALESCE(captured_at, imported_at)` and the
 * hand-authored partial index `media_items_display_gallery_idx` (intentional
 * schema drift, see migration 20260817000000_add_media_display_at) give the
 * gallery a single, gap-free keyset order that interleaves undated items by
 * their import time instead of floating them to the top by random UUID.
 *
 * Needs a database migrated to the latest schema (`npm run prisma:migrate`).
 * When no database is reachable the suite skips (logged) so the default
 * `npm test` stays runnable without Postgres, exactly like
 * test/android-app/one-current.db.spec.ts.
 */
import { PrismaService } from '../../src/prisma/prisma.service';

const MIN = 60_000;
const BASE = Date.parse('2024-06-01T12:00:00.000Z');
const at = (minutes: number) => new Date(BASE + minutes * MIN);

describe('media_items.display_at generated column + gallery index (db)', () => {
  let prisma: PrismaService | null = null;
  let userId: string;
  let circleId: string;
  let expectedOrder: string[]; // ids, display_at DESC, id DESC
  const displayAtById = new Map<string, Date>();

  const where = () => ({ circleId, deletedAt: null, archivedAt: null });
  const orderBy = [{ displayAt: 'desc' as const }, { id: 'desc' as const }];

  beforeAll(async () => {
    const candidate = new PrismaService();
    try {
      await candidate.$connect();
      await candidate.$queryRaw`SELECT 1`; // the pg adapter connects lazily
    } catch (err) {
      console.warn(`Skipping display-at.db.spec: database unreachable (${(err as Error).message})`);
      await candidate.$disconnect().catch(() => undefined);
      return;
    }
    prisma = candidate;

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const user = await prisma.user.create({ data: { email: `display-at-${stamp}@example.test` } });
    userId = user.id;
    const circle = await prisma.circle.create({
      data: { name: `display-at ${stamp}`, ownerId: userId },
    });
    circleId = circle.id;

    // 24 live items interleaving dated and undated rows. Dated rows are
    // captured at minutes 0,10,20,...; undated rows are IMPORTED at the odd
    // minutes in between (their captured_at is NULL), plus deliberate ties on
    // display_at so the id tiebreak is exercised across page boundaries.
    const specs: Array<{ captured: Date | null; imported: Date }> = [];
    for (let i = 0; i < 8; i++) specs.push({ captured: at(i * 10), imported: at(500 + i) });
    for (let i = 0; i < 8; i++) specs.push({ captured: null, imported: at(i * 10 + 5) });
    for (let i = 0; i < 4; i++) specs.push({ captured: at(30), imported: at(900) }); // tie on captured
    for (let i = 0; i < 4; i++) specs.push({ captured: null, imported: at(35) }); // tie on imported

    const live: string[] = [];
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      const obj = await prisma.storageObject.create({
        data: {
          name: `f${i}.jpg`,
          size: BigInt(1),
          mimeType: 'image/jpeg',
          storageKey: `test/display-at/${stamp}/${i}.jpg`,
          uploadedById: userId,
        },
      });
      const item = await prisma.mediaItem.create({
        data: {
          storageObjectId: obj.id,
          addedById: userId,
          circleId,
          type: 'photo',
          source: 'web',
          originalFilename: `f${i}.jpg`,
          capturedAt: s.captured,
          importedAt: s.imported,
        },
        select: { id: true, displayAt: true },
      });
      live.push(item.id);
      displayAtById.set(item.id, s.captured ?? s.imported);
    }

    // A trashed and an archived row must never appear in the gallery order.
    for (const flag of ['deletedAt', 'archivedAt'] as const) {
      const obj = await prisma.storageObject.create({
        data: {
          name: `${flag}.jpg`,
          size: BigInt(1),
          mimeType: 'image/jpeg',
          storageKey: `test/display-at/${stamp}/${flag}.jpg`,
          uploadedById: userId,
        },
      });
      await prisma.mediaItem.create({
        data: {
          storageObjectId: obj.id,
          addedById: userId,
          circleId,
          type: 'photo',
          source: 'web',
          originalFilename: `${flag}.jpg`,
          capturedAt: at(1000),
          [flag]: new Date(),
        },
      });
    }

    expectedOrder = [...live].sort((a, b) => {
      const d = displayAtById.get(b)!.getTime() - displayAtById.get(a)!.getTime();
      if (d !== 0) return d;
      return a < b ? 1 : a > b ? -1 : 0; // id DESC (uuid text order == pg uuid order)
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    const objects = await prisma.mediaItem.findMany({
      where: { circleId },
      select: { storageObjectId: true },
    });
    await prisma.mediaItem.deleteMany({ where: { circleId } }).catch(() => undefined);
    await prisma.circle.delete({ where: { id: circleId } }).catch(() => undefined);
    await prisma.storageObject
      .deleteMany({ where: { id: { in: objects.map((o) => o.storageObjectId) } } })
      .catch(() => undefined);
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await prisma.$disconnect();
  });

  it('computes display_at as COALESCE(captured_at, imported_at) and never NULL', async () => {
    if (!prisma) return;
    const rows = await prisma.$queryRaw<
      Array<{ id: string; ok: boolean; display_at: Date | null }>
    >`SELECT id, display_at,
             display_at = COALESCE(captured_at, imported_at) AS ok
        FROM media_items WHERE circle_id = ${circleId}::uuid`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.display_at).not.toBeNull();
      expect(r.ok).toBe(true);
    }
  });

  it('is omitted from default reads but readable via select and usable in orderBy', async () => {
    if (!prisma) return;
    const plain = await prisma.mediaItem.findFirst({ where: where() });
    expect(plain).not.toBeNull();
    expect(plain).not.toHaveProperty('displayAt');
    const selected = await prisma.mediaItem.findFirst({
      where: where(),
      select: { id: true, displayAt: true },
      orderBy,
    });
    expect(selected!.displayAt).toBeInstanceOf(Date);
  });

  it('follows captured_at edits (generated, never written by the app)', async () => {
    if (!prisma) return;
    const undated = [...displayAtById.keys()].find(
      (id) => displayAtById.get(id)!.getTime() === at(5).getTime(),
    )!;
    const edited = at(777);
    await prisma.mediaItem.update({ where: { id: undated }, data: { capturedAt: edited } });
    const after = await prisma.mediaItem.findUniqueOrThrow({
      where: { id: undated },
      select: { displayAt: true },
    });
    expect(after.displayAt.getTime()).toBe(edited.getTime());
    await prisma.mediaItem.update({ where: { id: undated }, data: { capturedAt: null } });
    const back = await prisma.mediaItem.findUniqueOrThrow({
      where: { id: undated },
      select: { displayAt: true },
    });
    expect(back.displayAt.getTime()).toBe(at(5).getTime());
  });

  it('orders undated items among dated ones by import time (no NULLS FIRST clump)', async () => {
    if (!prisma) return;
    const rows = await prisma.mediaItem.findMany({ where: where(), orderBy, select: { id: true } });
    expect(rows.map((r) => r.id)).toEqual(expectedOrder);

    // The old ORDER BY captured_at DESC put every NULL captured_at first.
    // Undated and dated rows must now interleave: a dated row appears before
    // the last undated row.
    const flags = await prisma.mediaItem.findMany({
      where: where(),
      orderBy,
      select: { capturedAt: true },
    });
    const lastUndated = flags.map((f) => f.capturedAt === null).lastIndexOf(true);
    const firstDated = flags.findIndex((f) => f.capturedAt !== null);
    expect(firstDated).toBeGreaterThanOrEqual(0);
    expect(firstDated).toBeLessThan(lastUndated);
  });

  it('keyset-pages by (display_at, id) with no gaps and no repeats', async () => {
    if (!prisma) return;
    const pageSize = 5; // 24 rows: several pages, ties straddle boundaries
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page = await prisma.mediaItem.findMany({
        where: where(),
        orderBy,
        take: pageSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true },
      });
      if (page.length === 0) break;
      seen.push(...page.map((p) => p.id));
      cursor = page[page.length - 1].id;
      if (page.length < pageSize) break;
    }
    expect(new Set(seen).size).toBe(seen.length); // no repeats
    expect(seen).toEqual(expectedOrder); // no gaps, exact order
  });

  it('serves the gallery query from media_items_display_gallery_idx', async () => {
    if (!prisma) return;
    // Tiny tables prefer a seq scan; disable it so the plan shows whether the
    // index CAN serve the ordering without a Sort node.
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      await tx.$executeRawUnsafe('SET LOCAL enable_bitmapscan = off');
      return tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
        `EXPLAIN SELECT id FROM media_items
          WHERE circle_id = '${circleId}'::uuid AND deleted_at IS NULL AND archived_at IS NULL
          ORDER BY display_at DESC, id DESC LIMIT 51`,
      );
    });
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    expect(text).toContain('media_items_display_gallery_idx');
    expect(text).not.toMatch(/\bSort\b/);
  });
});
