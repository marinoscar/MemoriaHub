/**
 * MediaDetailDrawer — canonical location names (Location Grouping, #375).
 *
 * The geo block shows the CANONICAL name a location group resolves a raw
 * geocoder value into, keeping the raw value as secondary text ONLY when the
 * two differ — an ungrouped value (where the canonical column simply mirrors
 * the raw one) must look exactly as it did before this feature.
 *
 * Mock preamble mirrors MediaDetailDrawerOrigin.test.tsx exactly: every service
 * the drawer's hooks fetch on mount is stubbed so nothing falls through to a
 * real network call on an unpredictable timeline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render, flushPendingAsyncWork } from '../../utils/test-utils';
import { MediaDetailDrawer } from '../../../components/media/MediaDetailDrawer';
import type { MediaItem } from '../../../types/media';

// ---------------------------------------------------------------------------
// Service mocks
// ---------------------------------------------------------------------------
vi.mock('../../../services/media', () => ({
  patchMedia: vi.fn(),
  getMedia: vi.fn(),
  bulkArchive: vi.fn(),
  bulkUnarchive: vi.fn(),
  bulkDelete: vi.fn(),
  bulkUpdateMedia: vi.fn(),
  bulkTags: vi.fn(),
  listTags: vi.fn().mockResolvedValue([]),
}));

import { getMedia } from '../../../services/media';

const mockGetMedia = vi.mocked(getMedia);

vi.mock('../../../services/face', () => ({
  getMediaFaces: vi.fn().mockResolvedValue([]),
  getMediaFaceStatus: vi.fn().mockResolvedValue({
    status: 'not_processed',
    faceCount: 0,
    providerKey: null,
    modelVersion: null,
    processedAt: null,
    lastError: null,
  }),
  rerunMediaFaces: vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'pending' }),
  listPeople: vi.fn().mockResolvedValue({ items: [], meta: { total: 0, page: 1, pageSize: 100 } }),
  getPerson: vi.fn().mockResolvedValue(null),
  createPerson: vi.fn().mockResolvedValue({}),
  updatePerson: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../../services/tagging', () => ({
  getMediaTagStatus: vi.fn().mockResolvedValue({
    status: 'not_processed',
    providerKey: null,
    modelVersion: null,
    tagCount: 0,
    processedAt: null,
    lastError: null,
  }),
  rerunMediaTags: vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'pending' }),
}));

vi.mock('../../../services/metadata', () => ({
  getMediaMetadataStatus: vi.fn().mockResolvedValue({
    status: 'not_processed',
    processedAt: null,
    lastError: null,
  }),
  rerunMediaMetadata: vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'pending' }),
}));

vi.mock('../../../components/media/VideoPlayer', () => ({
  VideoPlayer: ({ src }: any) => <div data-testid="video-player" data-src={src} />,
}));

vi.mock('../../../components/media/LocationMiniMap', () => ({
  LocationMiniMap: ({ lat, lng }: any) => (
    <div data-testid="location-mini-map" data-lat={lat} data-lng={lng} />
  ),
}));

vi.mock('../../../components/media/LocationPickerMap', () => ({
  LocationPickerMap: ({ onChange }: any) => (
    <div data-testid="location-picker-map" onClick={() => onChange({ lat: 10, lng: 20 })} />
  ),
}));

vi.mock('../../../components/media/TagAutocomplete', () => ({
  TagAutocomplete: ({ label, value, onChange }: any) => (
    <div data-testid={`tag-autocomplete-${label.toLowerCase().replace(/\s/g, '-')}`}>
      <input
        aria-label={label}
        value={value.join(',')}
        onChange={(e) => onChange(e.target.value ? e.target.value.split(',') : [])}
      />
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------
function makeMediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'media-item-geo-001',
    storageObjectId: 'storage-obj-001',
    addedById: 'user-001',
    circleId: 'circle-1',
    type: 'photo',
    capturedAt: '2024-06-15T10:30:00.000Z',
    capturedAtOffset: null,
    importedAt: '2024-06-16T08:00:00.000Z',
    source: 'web',
    contentHash: 'abc123',
    width: 1920,
    height: 1080,
    durationMs: null,
    orientation: 1,
    takenLat: null,
    takenLng: null,
    takenAltitude: null,
    cameraMake: 'Apple',
    cameraModel: 'iPhone 15 Pro',
    originalFilename: 'photo.jpg',
    description: null,
    favorite: false,
    geoCountry: 'Costa Rica',
    geoCountryCode: 'CR',
    geoAdmin1: 'Provincia de Heredia',
    geoAdmin2: null,
    geoLocality: 'Heredia',
    geoPlaceName: null,
    geoSource: 'offline',
    geocodedAt: null,
    coordSource: null,
    createdAt: '2024-06-16T08:00:00.000Z',
    updatedAt: '2024-06-16T09:00:00.000Z',
    deletedAt: null,
    archivedAt: null,
    burstGroupId: null,
    duplicateGroupId: null,
    metadata: null,
    thumbnailUrl: null,
    downloadUrl: null,
    ...overrides,
  };
}

function defaultProps(overrides: Partial<MediaItem> = {}) {
  return {
    item: makeMediaItem(overrides),
    open: true,
    onClose: vi.fn(),
    onItemUpdated: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('MediaDetailDrawer — canonical location names (#375)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMedia.mockResolvedValue(makeMediaItem({ downloadUrl: null }));
  });

  afterEach(async () => {
    await flushPendingAsyncWork();
  });

  it('shows the canonical name with the raw value as secondary text when they differ', () => {
    render(
      <MediaDetailDrawer
        {...defaultProps({
          geoAdmin1: 'Provincia de Heredia',
          geoCanonicalAdmin1: 'Heredia',
          geoLocality: null,
        })}
      />,
    );

    expect(screen.getByText('Heredia')).toBeInTheDocument();
    expect(screen.getByText(/from "Provincia de Heredia"/i)).toBeInTheDocument();
  });

  it('does NOT show secondary text when the canonical name equals the raw value', () => {
    render(
      <MediaDetailDrawer
        {...defaultProps({
          geoLocality: 'Heredia',
          geoCanonicalLocality: 'Heredia',
        })}
      />,
    );

    expect(screen.getByText('Heredia')).toBeInTheDocument();
    expect(screen.queryByText(/^from "/i)).not.toBeInTheDocument();
  });

  it('falls back to the raw value when no canonical column is present', () => {
    render(
      <MediaDetailDrawer
        {...defaultProps({
          geoAdmin1: 'Provincia de Heredia',
          geoCanonicalAdmin1: undefined,
        })}
      />,
    );

    expect(screen.getByText('Provincia de Heredia')).toBeInTheDocument();
    expect(screen.queryByText(/^from "/i)).not.toBeInTheDocument();
  });

  it('applies the same rule to the Country row', () => {
    render(
      <MediaDetailDrawer
        {...defaultProps({
          geoCountry: 'Republic of Costa Rica',
          geoCanonicalCountry: 'Costa Rica',
        })}
      />,
    );

    expect(screen.getByText('Costa Rica')).toBeInTheDocument();
    expect(screen.getByText(/from "Republic of Costa Rica"/i)).toBeInTheDocument();
  });
});
