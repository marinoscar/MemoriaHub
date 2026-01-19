import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '../../test/utils';
import { MediaCard } from './MediaCard';
import type { MediaAssetDTO } from '@memoriahub/shared';

const mockImageMedia: MediaAssetDTO = {
  id: 'media-1',
  libraryId: 'lib-1',
  originalFilename: 'photo.jpg',
  mediaType: 'image',
  mimeType: 'image/jpeg',
  fileSize: 1024000,
  fileSource: 'web',
  width: 1920,
  height: 1080,
  durationSeconds: null,
  cameraMake: 'Canon',
  cameraModel: 'EOS R5',
  latitude: null,
  longitude: null,
  country: null,
  state: null,
  city: null,
  locationName: null,
  capturedAtUtc: '2024-01-01T12:00:00Z',
  timezoneOffset: null,
  thumbnailUrl: 'https://example.com/thumb.jpg',
  previewUrl: 'https://example.com/preview.jpg',
  originalUrl: 'https://example.com/original.jpg',
  status: 'READY',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

const mockVideoMedia: MediaAssetDTO = {
  ...mockImageMedia,
  id: 'media-2',
  originalFilename: 'video.mp4',
  mediaType: 'video',
  mimeType: 'video/mp4',
  durationSeconds: 125,
};

describe('MediaCard', () => {
  it('renders with thumbnail image', () => {
    render(<MediaCard media={mockImageMedia} onClick={vi.fn()} />);

    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', 'https://example.com/thumb.jpg');
  });

  it('calls onClick with media id when clicked', () => {
    const handleClick = vi.fn();
    render(<MediaCard media={mockImageMedia} onClick={handleClick} />);

    const button = screen.getByRole('button');
    fireEvent.click(button);

    expect(handleClick).toHaveBeenCalledWith('media-1');
  });

  it('handles keyboard navigation (Enter key)', () => {
    const handleClick = vi.fn();
    render(<MediaCard media={mockImageMedia} onClick={handleClick} />);

    const button = screen.getByRole('button');
    fireEvent.keyDown(button, { key: 'Enter' });

    expect(handleClick).toHaveBeenCalledWith('media-1');
  });

  it('handles keyboard navigation (Space key)', () => {
    const handleClick = vi.fn();
    render(<MediaCard media={mockImageMedia} onClick={handleClick} />);

    const button = screen.getByRole('button');
    fireEvent.keyDown(button, { key: ' ' });

    expect(handleClick).toHaveBeenCalledWith('media-1');
  });

  it('displays video duration badge for videos after image loads', () => {
    render(<MediaCard media={mockVideoMedia} onClick={vi.fn()} />);

    // Simulate image load
    const img = screen.getByRole('img');
    fireEvent.load(img);

    // 125 seconds = 2:05
    expect(screen.getByText('2:05')).toBeInTheDocument();
  });

  it('has proper aria-label', () => {
    render(<MediaCard media={mockImageMedia} onClick={vi.fn()} />);

    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-label', 'View photo.jpg');
  });

  it('falls back to originalUrl when thumbnailUrl is null', () => {
    const mediaWithoutThumbnail: MediaAssetDTO = {
      ...mockImageMedia,
      thumbnailUrl: null,
      previewUrl: null,
    };
    render(<MediaCard media={mediaWithoutThumbnail} onClick={vi.fn()} />);

    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', 'https://example.com/original.jpg');
  });

  it('shows fallback icon when both thumbnailUrl and originalUrl fail to load', () => {
    const mediaWithoutThumbnail: MediaAssetDTO = {
      ...mockImageMedia,
      thumbnailUrl: null,
    };
    render(<MediaCard media={mediaWithoutThumbnail} onClick={vi.fn()} />);

    const img = screen.getByRole('img');
    fireEvent.error(img);

    // After error, broken image icon should appear
    expect(screen.getByTestId('BrokenImageIcon')).toBeInTheDocument();
  });
});
