import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '../../test/utils';
import { LibraryCard } from './LibraryCard';
import type { LibraryDTO } from '@memoriahub/shared';

const mockLibrary: LibraryDTO = {
  id: '123',
  ownerId: 'owner-1',
  name: 'Family Photos',
  description: 'Our family photo collection',
  visibility: 'private',
  coverAssetId: null,
  coverUrl: null,
  assetCount: 42,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

describe('LibraryCard', () => {
  it('renders library name', () => {
    render(<LibraryCard library={mockLibrary} />);

    expect(screen.getByText('Family Photos')).toBeInTheDocument();
  });

  it('renders library description', () => {
    render(<LibraryCard library={mockLibrary} />);

    expect(screen.getByText('Our family photo collection')).toBeInTheDocument();
  });

  it('renders "No description" when description is null', () => {
    const libraryNoDesc = { ...mockLibrary, description: null };
    render(<LibraryCard library={libraryNoDesc} />);

    expect(screen.getByText('No description')).toBeInTheDocument();
  });

  it('renders asset count', () => {
    render(<LibraryCard library={mockLibrary} />);

    expect(screen.getByText('42 items')).toBeInTheDocument();
  });

  it('renders singular "item" when count is 1', () => {
    const singleAsset = { ...mockLibrary, assetCount: 1 };
    render(<LibraryCard library={singleAsset} />);

    expect(screen.getByText('1 item')).toBeInTheDocument();
  });

  it('renders private visibility badge', () => {
    render(<LibraryCard library={mockLibrary} />);

    expect(screen.getByText('Private')).toBeInTheDocument();
  });

  it('renders shared visibility badge', () => {
    const sharedLibrary = { ...mockLibrary, visibility: 'shared' as const };
    render(<LibraryCard library={sharedLibrary} />);

    expect(screen.getByText('Shared')).toBeInTheDocument();
  });

  it('renders public visibility badge', () => {
    const publicLibrary = { ...mockLibrary, visibility: 'public' as const };
    render(<LibraryCard library={publicLibrary} />);

    expect(screen.getByText('Public')).toBeInTheDocument();
  });

  it('calls onClick when clicked', () => {
    const handleClick = vi.fn();
    render(<LibraryCard library={mockLibrary} onClick={handleClick} />);

    const button = screen.getByRole('button');
    fireEvent.click(button);

    expect(handleClick).toHaveBeenCalledWith(mockLibrary);
  });

  it('renders cover image when coverUrl is provided', () => {
    const libraryWithCover = { ...mockLibrary, coverUrl: 'https://example.com/cover.jpg' };
    render(<LibraryCard library={libraryWithCover} />);

    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', 'https://example.com/cover.jpg');
    expect(img).toHaveAttribute('alt', 'Family Photos');
  });

  it('renders placeholder icon when no coverUrl', () => {
    render(<LibraryCard library={mockLibrary} />);

    // Should not have an img element
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    // Should have the placeholder icon (rendered by MUI, check by test-id or SVG)
    expect(screen.getByTestId('PhotoLibraryIcon')).toBeInTheDocument();
  });
});
