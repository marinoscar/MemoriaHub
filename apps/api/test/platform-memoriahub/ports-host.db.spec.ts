// =============================================================================
// The object-store, settings and secrets ports over the booted host on real PostgreSQL and a real folder
// (RETRO-J4, #610; retro-gaps audit)
// =============================================================================
//
// `ports-conformance.spec.ts` runs these three sections of the ports kit against stand-ins (a stand-in storage
// driver, in-memory settings and credential rows). Here the same rules run on the REAL bindings of the booted
// application, `MEMORIAHUB_OBJECT_STORE`, `MEMORIAHUB_SETTINGS` and `MEMORIAHUB_SECRETS`:
//
//   - object store: the platform storage slice with the `local` driver pointed at a temporary folder (upload,
//     size, download, signed link, delete, delete-many, a missing object, a recorded location);
//   - settings: the platform settings slice over the real `system_settings` and `user_settings` rows, with the
//     version check;
//   - secrets: the platform credential store over the real encrypted `credentials` rows (the value is never
//     returned by `status`, only by `get`).
//
// The application's Prisma client is the row-level-security bypass connection (see `rlsBypassPrisma`).
// DB_GATED: reported as skipped (never passed) when no database is reachable.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Test, type TestingModule } from '@nestjs/testing';
import { OfflineGeoLocationProvider } from '@marinoscar/memoriahub-api/location';
import {
  MEMORIAHUB_OBJECT_STORE,
  MEMORIAHUB_SECRETS,
  MEMORIAHUB_SETTINGS,
} from '@marinoscar/memoriahub-api/ports';
import { describeMemoriahubPortsConformance, type MemoriahubPortsUnderTest } from '@marinoscar/memoriahub-api/testing';
import { z } from 'zod';

import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { isDatabaseReachable } from '../helpers/db-probe.helper';
import { rlsBypassPrisma } from '../helpers/org-scope';

const describeMaybeDb = isDatabaseReachable() ? describe : describe.skip;

describeMaybeDb('object store, settings and secrets ports on the booted host (DB_GATED)', () => {
  let prisma: PrismaService;
  let bypass: PrismaService;
  let moduleRef: TestingModule;
  let userId: string;
  let root: string;
  let previousStorage: unknown;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    bypass = await rlsBypassPrisma();
    userId = (await prisma.user.create({ data: { email: `ports-host-${randomUUID()}@example.test` } })).id;
    root = await mkdtemp(join(tmpdir(), 'mh-ports-store-'));

    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(bypass)
      .overrideProvider(OfflineGeoLocationProvider)
      .useValue({ onModuleInit: async () => undefined, reverseGeocode: async () => null })
      .compile();
    await moduleRef.init();

    // The local driver, pointed at the temporary folder, is the active one for the object-store rules.
    const settings = moduleRef.get(MEMORIAHUB_SETTINGS, { strict: false });
    previousStorage = (await settings.readSystem('storage')).value;
    const patched = await settings.patchSystem('storage', { provider: 'local', drivers: { local: { rootDir: root } } } as never, { actorUserId: userId });
    expect((patched.value as { provider?: string }).provider).toBe('local');
    // The storage slice caches the active configuration for 5 s (`STORAGE_POLICY_CACHE_MS`, a constant).
    await new Promise((resolve) => setTimeout(resolve, 5500));
  }, 120000);

  afterAll(async () => {
    try {
      const previous = previousStorage as { provider?: string } | undefined;
      if (previous?.provider) {
        await moduleRef?.get(MEMORIAHUB_SETTINGS, { strict: false }).patchSystem('storage', { provider: previous.provider } as never, { actorUserId: userId });
      }
    } catch {
      /* best effort */
    }
    await moduleRef?.close();
    await bypass?.$disconnect();
    if (userId) await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
    await prisma?.$disconnect();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const underTest = (): MemoriahubPortsUnderTest => ({
    objectStore: { port: moduleRef.get(MEMORIAHUB_OBJECT_STORE, { strict: false }) },
    settings: {
      port: moduleRef.get(MEMORIAHUB_SETTINGS, { strict: false }),
      namespaces: [
        { scope: 'system', name: 'dedup', schema: z.object({ hashMaxDistance: z.number() }), defaults: { hashMaxDistance: 6 } },
        { scope: 'user', name: 'memories', schema: z.object({ emailDigestOptOut: z.boolean() }), defaults: { emailDigestOptOut: false } },
      ],
      system: { name: 'dedup', patch: { hashMaxDistance: 8 }, actorUserId: userId },
      user: { name: 'memories', userId, patch: { emailDigestOptOut: true } },
    },
    secrets: { port: moduleRef.get(MEMORIAHUB_SECRETS, { strict: false }), purpose: 'geo_provider', name: `ports-host-${randomUUID().slice(0, 8)}`, actorUserId: userId },
  });

  describeMemoriahubPortsConformance(
    'the booted host: local storage folder, real settings and credential rows',
    underTest,
    { describe, it, expect },
    { skip: ['jobs', 'ai', 'access', 'identity', 'notify', 'events', 'audit', 'webhooks', 'metrics'] },
  );
});
