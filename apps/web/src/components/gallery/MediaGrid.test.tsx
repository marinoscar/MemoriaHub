import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '../../test/utils';
import { MediaGrid } from './MediaGrid';
import type { MediaAssetDTO } from '@memoriahub/shared';

const mockMedia: MediaAssetDTO[] = [
  {
    id: 'media-1',
    ownerId: 'user-1',
    originalFilename: 'photo1.jpg',
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
    thumbnailUrl: 'https://example.com/thumb1.jpg',
    previewUrl: 'https://example.com/preview1.jpg',
    originalUrl: 'https://example.com/original1.jpg',
    status: 'READY',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'media-2',
    ownerId: 'user-1',
    originalFilename: 'photo2.jpg',
    mediaType: 'image',
    mimeType: 'image/jpeg',
    fileSize: 2048000,
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
    capturedAtUtc: '2024-01-02T12:00:00Z',
    timezoneOffset: null,
    thumbnailUrl: 'https://example.com/thumb2.jpg',
    previewUrl: 'https://example.com/preview2.jpg',
    originalUrl: 'https://example.com/original2.jpg',
    status: 'READY',
    createdAt: '2024-01-02T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
  },
];

describe('MediaGrid', () => {
  it('renders media cards', () => {
    render(<MediaGrid media={mockMedia} onMediaClick={vi.fn()} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
  });

  it('shows skeleton when loading with no media', () => {
    const { container } = render(
      <MediaGrid media={[]} isLoading={true} onMediaClick={vi.fn()} />
    );

    const skeletons = container.querySelectorAll('.MuiSkeleton-root');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('shows empty state when no media and not loading', () => {
    render(<MediaGrid media={[]} isLoading={false} onMediaClick={vi.fn()} />);

    expect(screen.getByText('No photos or videos yet')).toBeInTheDocument();
  });

  it('calls onMediaClick when a card is clicked', () => {
    const handleClick = vi.fn();
    render(<MediaGrid media={mockMedia} onMediaClick={handleClick} />);

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[0]);

    expect(handleClick).toHaveBeenCalledWith('media-1');
  });

  it('calls onUploadClick when upload button in empty state is clicked', () => {
    const handleUpload = vi.fn();
    render(
      <MediaGrid
        media={[]}
        isLoading={false}
        onMediaClick={vi.fn()}
        onUploadClick={handleUpload}
      />
    );

    const uploadButton = screen.getByRole('button', { name: /upload photos/i });
    fireEvent.click(uploadButton);

    expect(handleUpload).toHaveBeenCalled();
  });
});
