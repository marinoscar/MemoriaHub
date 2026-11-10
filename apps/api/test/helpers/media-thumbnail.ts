// =============================================================================
// The real `MediaThumbnailService` over the mocks the specs always provided (RETRO-J5, #613)
// =============================================================================
//
// The service moved to the media slice and reads storage through `MEMORIAHUB_OBJECT_STORE`. Specs
// that exercise it as a real collaborator keep mocking `PrismaService`, `STORAGE_PROVIDER` (the active
// driver) and `StorageProviderResolver` (the recorded driver); this provider puts the port in front of
// those same mocks.
// =============================================================================

import { MediaThumbnailService } from '@marinoscar/memoriahub-api/media';
import { STORAGE_PROVIDER } from '@marinoscar/platform-api/storage';

import { StorageProviderResolver } from '../../src/platform/storage/storage-provider.resolver';
import { PrismaService } from '../../src/prisma/prisma.service';

/** The Nest provider of a real `MediaThumbnailService` over mocked collaborators. */
export const thumbnailServiceOverMocks = {
  provide: MediaThumbnailService,
  useFactory: (prisma: PrismaService, active: unknown, resolver: StorageProviderResolver) =>
    new MediaThumbnailService(
      prisma as never,
      {
        forLocation: (provider: string | null | undefined, bucket?: string | null) => resolver.getProviderFor(provider as never, bucket as never),
        active: async () => ({ id: 'active', store: active }),
      } as never,
    ),
  inject: [PrismaService, STORAGE_PROVIDER, StorageProviderResolver],
};
