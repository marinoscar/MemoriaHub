/**
 * Test helper functions and mock data factories
 */

import type { MediaAssetDTO, LibraryDTO } from '@memoriahub/shared';

/**
 * Creates a mock MediaAssetDTO for testing
 */
export const createMockMedia = (
  id: string,
  overrides: Partial<MediaAssetDTO> = {}
): MediaAssetDTO => ({
  id,
  ownerId: 'user-1',
  originalFilename: `image-${id}.jpg`,
  mediaType: 'image',
  mimeType: 'image/jpeg',
  fileSize: 1024000,
  fileSource: 'web',
  width: 1920,
  height: 1080,
  durationSeconds: null,
  cameraMake: null,
  cameraModel: null,
  latitude: null,
  longitude: null,
  country: null,
  state: null,
  city: null,
  locationName: null,
  capturedAtUtc: '2024-01-01T12:00:00Z',
  timezoneOffset: null,
  thumbnailUrl: `https://example.com/${id}-thumb.jpg`,
  previewUrl: `https://example.com/${id}-preview.jpg`,
  originalUrl: `https://example.com/${id}-full.jpg`,
  status: 'READY',
  createdAt: '2024-01-01T12:00:00Z',
  updatedAt: '2024-01-01T12:00:00Z',
  ...overrides,
});

/**
 * Creates a mock LibraryDTO for testing
 */
export const createMockLibrary = (
  id: string,
  name: string,
  overrides: Partial<LibraryDTO> = {}
): LibraryDTO => ({
  id,
  ownerId: 'user-1',
  name,
  description: `Description for ${name}`,
  visibility: 'private',
  coverAssetId: null,
  assetCount: 0,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  ...overrides,
});
