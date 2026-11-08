// =============================================================================
// How MemoriaHub builds itself for the `doctor-read-only` suite (RETRO-B1b, #602)
// =============================================================================
//
// The suite hands the fixture two doubles, a Prisma client that records every
// call and a storage provider that refuses every write, and asks for the app
// booted with them installed. It then runs every check the booted
// `DoctorCheckRegistry` holds.
//
// Two overrides carry the doubles:
//   - `PrismaService`           what every MemoriaHub service reads through
//                               (and `PLATFORM_PRISMA`, bound `useExisting`);
//   - `StorageProviderResolver` MemoriaHub has no `STORAGE_PROVIDER` token on
//                               the check path: the storage checks resolve the
//                               active provider through this class.
// Everything else is the real `AppModule` over `createTestApp`'s mocked database.
// =============================================================================

import type { DoctorConformanceFixture } from '@marinoscar/platform-api/doctor/testing';

import { PrismaService } from '../../src/prisma/prisma.service';
import { StorageProviderResolver } from '../../src/storage/providers/storage-provider.resolver';
import { closeTestApp, createTestApp, type TestContext } from '../helpers/test-app.helper';

export const doctorConformanceFixture: DoctorConformanceFixture = {
  createContext: ({ prisma, storage }) =>
    createTestApp({
      useMockDatabase: true,
      overrideProviders: [
        { provide: PrismaService, useValue: prisma.client },
        {
          provide: StorageProviderResolver,
          useValue: {
            getProviderFor: async () => storage.provider,
            getActiveProvider: async () => storage.provider,
            invalidate: () => undefined,
          },
        },
      ],
    }),
  closeContext: (context) => closeTestApp(context as TestContext),
};
