/**
 * Render snapshot of the viewer's properties drawer, through the fake host (RETRO-J11, #626).
 *
 * Same mocks as `MediaDetailDrawer.test.tsx` (the maps, the tag and face hooks and the video player are
 * stubbed so the tree is deterministic); the drawer itself, its sections and the host's link-share slot are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, flushPendingAsyncWork, setTestHostDefaults, resetTestHostDefaults } from '../utils/test-utils.js';
import { normalizedHtml } from '../utils/domSnapshot.js';
import { MediaDetailDrawer } from '../../src/viewer/ui/components/MediaDetailDrawer.js';
import type { MediaItem } from '../../src/media/headless/index.js';

// ---------------------------------------------------------------------------
// Mock the media service (both patchMedia and getMedia)
// ---------------------------------------------------------------------------

vi.mock('../../src/media/headless/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  patchMedia: vi.fn(),
  getMedia: vi.fn(),
  bulkUpdateMedia: vi.fn(),
  bulkTags: vi.fn(),
  listTags: vi.fn().mockResolvedValue([]),

  getMediaMetadataStatus: vi.fn().mockResolvedValue({
    status: 'not_processed',
    processedAt: null,
    lastError: null,
  }),
  rerunMediaMetadata: vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'pending' }),

  rerunThumbnail: vi.fn(),

}));

import { patchMedia, getMedia } from '../../src/media/headless/index.js';

const mockPatchMedia = vi.mocked(patchMedia);
const mockGetMedia = vi.mocked(getMedia);

// ---------------------------------------------------------------------------
// Mock the face service — FaceThumbnails (mounted inside the drawer) calls
// getMediaFaces and getMediaFaceStatus on mount via useMediaFaces. Without
// this mock the hook issues real fetches that fail in jsdom and pollute the
// test output with "fetch failed" errors.
// ---------------------------------------------------------------------------

// The platform's inline link-share panel is a host slot of the viewer; its contents are the platform's (the app's LinkSharePanel.test.tsx).
const LinkSharePanelStub = ({ target }: { target: { id: string } }) => <button type="button">Create link {target.id}</button>;

vi.mock('../../src/people/headless/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/people/headless/index.js')>()),
  // The drawer's face hook fetches on mount; a stable stub keeps the file's async work deterministic.
  useMediaFaces: () => ({
    faces: [],
    status: {
      status: 'not_processed',
      faceCount: 0,
      providerKey: null,
      modelVersion: null,
      processedAt: null,
      lastError: null,
    },
    loading: false,
    error: null,
    rerun: vi.fn(),
    rerunLoading: false,
    refresh: vi.fn(),
  }),
  rerunMediaFaces: vi.fn().mockResolvedValue({ jobId: 'job-1', status: 'pending' }),
  listPeople: vi.fn().mockResolvedValue({ items: [], meta: { total: 0, page: 1, pageSize: 100 } }),
  getPerson: vi.fn().mockResolvedValue(null),
  createPerson: vi.fn().mockResolvedValue({}),
  updatePerson: vi.fn().mockResolvedValue({}),
}));

// ---------------------------------------------------------------------------
// Mock tagging/metadata services — useMediaTags / useMediaMetadata (mounted
// inside the drawer) fetch these on mount. Without these mocks the requests
// fall through to MSW as unhandled, bypass to a real (failing) network call,
// and settle on an unpredictable timeline instead of a deterministic
// microtask — exactly the kind of dangling continuation
// `flushPendingAsyncWork` below exists to drain before this file's tests
// finish (issue #196).
// ---------------------------------------------------------------------------

vi.mock('../../src/tagging/headless/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The drawer's tag hook fetches on mount; a stable stub keeps the file's async work deterministic.
  useMediaTags: () => ({
    status: {
      status: 'not_processed',
      providerKey: null,
      modelVersion: null,
      tagCount: 0,
      processedAt: null,
      lastError: null,
    },
    loading: false,
    error: null,
    rerun: vi.fn(),
    rerunLoading: false,
  }),
}));



// ---------------------------------------------------------------------------
// Mock VideoPlayer — avoids @vidstack/react dependency in tests
// ---------------------------------------------------------------------------

vi.mock('../../src/viewer/ui/components/VideoPlayer.js', () => ({
  VideoPlayer: ({ src, poster, title }: any) => (
    <div
      data-testid="video-player"
      data-src={src}
      data-poster={poster}
      data-title={title}
    />
  ),
}));

// ---------------------------------------------------------------------------
// Mock LocationMiniMap — avoids react-leaflet/leaflet dependency in tests
// ---------------------------------------------------------------------------

vi.mock('../../src/media/ui/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  LocationMiniMap: ({ lat, lng, label }: any) => (
    <div
      data-testid="location-mini-map"
      data-lat={lat}
      data-lng={lng}
      data-label={label}
    />
  ),

  LocationPickerMap: ({ value, onChange }: any) => (
    <div
      data-testid="location-picker-map"
      data-lat={value?.lat}
      data-lng={value?.lng}
      onClick={() => onChange({ lat: 10, lng: 20 })}
    />
  ),

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
// Mock LocationPickerMap — avoids react-leaflet/leaflet dependency in tests
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// Mock TagAutocomplete — avoids Autocomplete complexity in tests
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// Mock useLocationSuggestions hooks (useSuggestLocation, useItemAutoAppliedSuggestion)
// — location inference behavior added in commit eba3e6b.
// ---------------------------------------------------------------------------

vi.mock('../../src/review/headless/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useSuggestLocation: vi.fn(),
  useItemAutoAppliedSuggestion: vi.fn(),
  useItemLocationCandidate: vi.fn(),
  revertLocationSuggestion: vi.fn(),
}));

import {
  useSuggestLocation,
  useItemAutoAppliedSuggestion,
  useItemLocationCandidate,
  revertLocationSuggestion,
} from '../../src/review/headless/index.js';

const mockUseSuggestLocation = vi.mocked(useSuggestLocation);
const mockUseItemAutoAppliedSuggestion = vi.mocked(useItemAutoAppliedSuggestion);
const mockUseItemLocationCandidate = vi.mocked(useItemLocationCandidate);
const mockRevertLocationSuggestion = vi.mocked(revertLocationSuggestion);

// ---------------------------------------------------------------------------
// Mock the thumbnail service — Retry thumbnail button
// ---------------------------------------------------------------------------



import { rerunThumbnail } from '../../src/media/headless/index.js';

const mockRerunThumbnail = vi.mocked(rerunThumbnail);

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

const ITEM_ID = 'media-item-001';

function makeMediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: ITEM_ID,
    storageObjectId: 'storage-obj-001',
    ownerId: 'user-001',
    type: 'photo',
    capturedAt: '2024-06-15T10:30:00.000Z',
    capturedAtOffset: -360,
    importedAt: '2024-06-16T08:00:00.000Z',
    source: 'web',
    contentHash: 'abc123def456',
    width: 4032,
    height: 3024,
    durationMs: null,
    orientation: 1,
    takenLat: 9.9281,
    takenLng: -84.0907,
    takenAltitude: 1247.5,
    cameraMake: 'Apple',
    cameraModel: 'iPhone 15 Pro',
    originalFilename: 'DSC_0001.jpg',
    description: 'Beautiful sunset at Arenal',
    favorite: false,
    geoCountry: 'Costa Rica',
    geoCountryCode: 'CR',
    geoAdmin1: 'Alajuela',
    geoAdmin2: 'San Carlos',
    geoLocality: 'La Fortuna',
    geoPlaceName: 'Arenal Volcano',
    geoSource: 'geonames-offline',
    geocodedAt: '2024-06-16T09:00:00.000Z',
    createdAt: '2024-06-16T08:00:00.000Z',
    updatedAt: '2024-06-16T09:00:00.000Z',
    deletedAt: null,
    metadata: null,
    thumbnailUrl: null,
    downloadUrl: null,
    coordSource: null,
    ...overrides,
  };
}

function makeVideoItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return makeMediaItem({
    type: 'video',
    durationMs: 62000,
    ...overrides,
  });
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

describe('MediaDetailDrawer render snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTestHostDefaults({ slots: { 'viewer.linkSharePanel': LinkSharePanelStub } });
    mockGetMedia.mockResolvedValue(makeMediaItem({ downloadUrl: 'https://cdn.example.test/photo.jpg' }));
    mockPatchMedia.mockResolvedValue(makeMediaItem());
    mockUseSuggestLocation.mockReturnValue({ suggest: vi.fn(), loading: false, error: null });
    mockUseItemAutoAppliedSuggestion.mockReturnValue({ suggestionId: null, loading: false });
    mockUseItemLocationCandidate.mockReturnValue({ candidate: null, loading: false });
    mockRevertLocationSuggestion.mockResolvedValue({ id: 'suggestion-1', status: 'reverted' });
    mockRerunThumbnail.mockResolvedValue({ status: 'ready' });
  });

  afterEach(async () => {
    await flushPendingAsyncWork();
    resetTestHostDefaults();
  });

  it('a photo with location, camera and a description', async () => {
    render(<MediaDetailDrawer {...defaultProps()} />);
    await screen.findAllByText('DSC_0001.jpg');
    await waitFor(() => expect(screen.getByTestId('location-mini-map')).toBeInTheDocument());
    expect(normalizedHtml(document.body)).toMatchSnapshot();
  });

  it('a video shows its duration', async () => {
    render(<MediaDetailDrawer {...defaultProps({ type: 'video', durationMs: 62000 })} />);
    await screen.findAllByText('DSC_0001.jpg');
    expect(screen.getByText('video')).toBeInTheDocument();
    expect(normalizedHtml(document.body)).toMatchSnapshot();
  });
});
