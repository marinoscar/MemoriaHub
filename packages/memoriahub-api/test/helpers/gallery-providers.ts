// The Nest providers a spec of the gallery service (`MediaService`) builds its module from: the
// ports and hooks the service injects, each backed by the mocks the specs configure.

import {
  MEMORIAHUB_ACCESS,
  MEMORIAHUB_METRICS,
  MEMORIAHUB_OBJECT_STORE,
  MEMORIAHUB_PRISMA,
} from '../../src/ports/index.js';
import {
  MEDIA_ENRICHMENT,
  MEDIA_FORWARD_GEOCODER,
  MEDIA_GEO_LOCATION_PROVIDER,
  MEDIA_LOCATION_RESOLVER,
  MEDIA_WEBHOOK_EVENTS,
  MediaThumbnailService,
  MediaMetadataSyncService,
  MediaTouchService,
  ReviewQueueCounterRegistry,
  UploadNotificationService,
} from '../../src/media/index.js';

/** The mocks a spec supplies. */
export interface GalleryMocks {
  prisma: unknown;
  /** The ACTIVE object store (`getSignedDownloadUrl`, `delete`, `getBucket`, `deleteMany`). */
  activeStore: unknown;
  /** `getProviderFor(provider, bucket)` of the store a recorded location resolves to. */
  resolver: { getProviderFor: jest.Mock };
  /** `requireOwnerRole` of the owner-scope check. */
  ownerAccess: { requireOwnerRole: jest.Mock } & Record<string, unknown>;
  geo: unknown;
  forwardGeocode: unknown;
  enrichment: unknown;
  locationResolver: unknown;
  sync: unknown;
  uploadNotification: unknown;
  touch: unknown;
  metrics?: unknown;
  webhooks?: unknown;
}

/** The object store port over the mocked active store and resolver. */
export function objectStoreOver(activeStore: unknown, resolver: { getProviderFor: jest.Mock }) {
  return {
    active: async () => ({ id: 'active', store: activeStore }),
    forLocation: (provider: string | null | undefined, bucket?: string | null) => resolver.getProviderFor(provider, bucket),
  };
}

/**
 * The access port: the mocked owner check plus no grants (a record grant never allows). The given
 * object is completed in place, so a spec can assert on `deleteGrantsFor` through it.
 */
export function accessOver<T extends { requireOwnerRole: jest.Mock }>(ownerAccess: T) {
  const target: Record<string, any> = ownerAccess;
  target['grantAllows'] ??= jest.fn().mockResolvedValue(false);
  target['grantsAllowAll'] ??= jest.fn().mockResolvedValue(false);
  target['sharedWhere'] ??= jest.fn().mockResolvedValue(null);
  target['deleteGrantsFor'] ??= jest.fn().mockResolvedValue(0);
  return ownerAccess;
}

/**
 * The review-queue counters the owning slices register, as stubs over the mocked models: the media slice only
 * aggregates them (each slice's own spec proves the query it runs), so the dashboard and badge specs stay in
 * this slice.
 */
export function reviewQueueRegistryOver(prisma: any): ReviewQueueCounterRegistry {
  const registry = new ReviewQueueCounterRegistry();
  const counter = (
    countKey: 'pendingBurstGroups' | 'pendingDuplicateGroups' | 'pendingLocationSuggestions' | 'pendingEnhancements',
    count: (libraryId: string) => Promise<number>,
  ) => registry.registerReviewQueueCounter({ countKey, eventKey: countKey, isEnabled: () => true, count });
  counter('pendingBurstGroups', (circleId) =>
    prisma.burstGroup.count({ where: { circleId, status: 'pending', mediaCount: { gte: 3 } } }),
  );
  counter('pendingDuplicateGroups', (circleId) => prisma.duplicateGroup.count({ where: { circleId, status: 'pending' } }));
  counter('pendingLocationSuggestions', (circleId) => prisma.locationSuggestion.count({ where: { circleId, status: 'pending' } }));
  counter('pendingEnhancements', (circleId) => prisma.mediaEnhancement.count({ where: { circleId, status: 'ready' } }));
  return registry;
}

/** The real `MediaThumbnailService` over the mocks, so batched and legacy signing stay faithful. */
export const thumbnailServiceOverMocks = {
  provide: MediaThumbnailService,
  useFactory: (prisma: unknown, objectStore: unknown) => new MediaThumbnailService(prisma as never, objectStore as never),
  inject: [MEMORIAHUB_PRISMA, MEMORIAHUB_OBJECT_STORE],
};

/** The provider list (without `MediaService` itself). */
export function galleryProviders(m: GalleryMocks): any[] {
  const objectStore = objectStoreOver(m.activeStore, m.resolver);
  return [
    thumbnailServiceOverMocks,
    { provide: MEMORIAHUB_PRISMA, useValue: m.prisma },
    { provide: ReviewQueueCounterRegistry, useValue: reviewQueueRegistryOver(m.prisma) },
    { provide: MEMORIAHUB_OBJECT_STORE, useValue: objectStore },
    { provide: MEMORIAHUB_ACCESS, useValue: accessOver(m.ownerAccess) },
    { provide: MEDIA_GEO_LOCATION_PROVIDER, useValue: m.geo },
    { provide: MEDIA_FORWARD_GEOCODER, useValue: m.forwardGeocode },
    { provide: MEDIA_ENRICHMENT, useValue: m.enrichment },
    { provide: MEDIA_LOCATION_RESOLVER, useValue: m.locationResolver },
    { provide: MediaMetadataSyncService, useValue: m.sync },
    { provide: UploadNotificationService, useValue: m.uploadNotification },
    { provide: MediaTouchService, useValue: m.touch },
    ...(m.metrics ? [{ provide: MEMORIAHUB_METRICS, useValue: m.metrics }] : []),
    ...(m.webhooks ? [{ provide: MEDIA_WEBHOOK_EVENTS, useValue: m.webhooks }] : []),
  ];
}
