// =============================================================================
// Providers of the gallery service over the mocks the specs always provided (RETRO-J5, #613)
// =============================================================================
//
// `MediaService` moved to the media slice and reads the database, access policy and object store
// through the `ports` tokens and the geocoders / enrichment helpers through the media hooks. These
// helpers put those tokens in front of the same mocks (the active store, the recorded-location
// resolver and the owner-scope check) the app specs build.
// =============================================================================

import { stringify as csvStringify } from 'csv-stringify';
import { MEDIA_CSV_STRINGIFIER, MediaThumbnailService } from '@marinoscar/memoriahub-api/media';
import { MEMORIAHUB_OBJECT_STORE, MEMORIAHUB_PRISMA } from '@marinoscar/memoriahub-api/ports';

/** The object store port over the mocked active store and the recorded-location resolver. */
export function objectStoreOver(activeStore: unknown, resolver: { getProviderFor: jest.Mock }) {
  return {
    active: async () => ({ id: 'active', store: activeStore }),
    forLocation: (provider: string | null | undefined, bucket?: string | null) => resolver.getProviderFor(provider, bucket),
  };
}

/** The access port: the mocked owner check completed with no grants (a record grant never allows). */
export function accessOver<T extends { requireOwnerRole: jest.Mock }>(ownerAccess: T) {
  const target: Record<string, any> = ownerAccess;
  target['grantAllows'] ??= jest.fn().mockResolvedValue(false);
  target['grantsAllowAll'] ??= jest.fn().mockResolvedValue(false);
  target['sharedWhere'] ??= jest.fn().mockResolvedValue(null);
  target['deleteGrantsFor'] ??= jest.fn().mockResolvedValue(0);
  return ownerAccess;
}

/** A real `MediaThumbnailService` over the port mocks. */
export const thumbnailServiceOverMocks = {
  provide: MediaThumbnailService,
  useFactory: (prisma: unknown, objectStore: unknown) => new MediaThumbnailService(prisma as never, objectStore as never),
  inject: [MEMORIAHUB_PRISMA, MEMORIAHUB_OBJECT_STORE],
};

/** The CSV writer the host binds (`csv-stringify`). */
export const csvStringifierProvider = {
  provide: MEDIA_CSV_STRINGIFIER,
  useValue: { create: (columns: string[]) => csvStringify({ header: true, columns }) },
};
