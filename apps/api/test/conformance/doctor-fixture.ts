// =============================================================================
// How MemoriaHub builds itself for the `doctor-read-only` suite (RETRO-B1b, #602)
// =============================================================================
//
// The suite hands the fixture two doubles, a Prisma client that records every
// call and a storage provider that refuses every write, and asks for the app
// booted with them installed. It then runs every check the booted
// `DoctorCheckRegistry` holds.
//
// Three overrides carry the doubles:
//   - `PrismaService`           what every MemoriaHub service reads through
//                               (and `PLATFORM_PRISMA`, bound `useExisting`);
//   - `PrismaSystemService`     the bypass client (RETRO-D1): `asSystem` /
//                               `runAsSystem` hand out the same recording client;
//   - `StorageProviderResolver` MemoriaHub's view of the platform object store
//                               (the Android upload-path check resolves through it).
// Everything else is the real `AppModule` over `createTestApp`'s mocked database.
// =============================================================================

import type { DoctorConformanceFixture } from '@marinoscar/platform-api/doctor/testing';

import { PrismaService } from '../../src/prisma/prisma.service';
import { PrismaSystemService } from '../../src/prisma/prisma-system.service';
import { StorageProviderResolver } from '../../src/platform/storage/storage-provider.resolver';
import { closeTestApp, createTestApp, type TestContext } from '../helpers/test-app.helper';

export const doctorConformanceFixture: DoctorConformanceFixture = {
  createContext: ({ prisma, storage }) =>
    createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        { provide: PrismaService, useValue: prisma.client },
        {
          provide: PrismaSystemService,
          useValue: {
            asSystem: () => prisma.client,
            runAsSystem: (_reason: string, fn: (tx: unknown) => unknown) => fn(prisma.client),
          },
        },
        {
          provide: StorageProviderResolver,
          useValue: {
            getProviderFor: async () => storage.provider,
            getActiveProvider: async () => ({ id: 's3', provider: storage.provider }),
            invalidate: () => undefined,
          },
        },
      ],
    }),
  closeContext: (context) => closeTestApp(context as TestContext),
};
