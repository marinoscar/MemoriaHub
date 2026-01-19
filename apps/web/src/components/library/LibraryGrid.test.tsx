import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '../../test/utils';
import { LibraryGrid } from './LibraryGrid';
import type { LibraryDTO } from '@memoriahub/shared';

const mockLibraries: LibraryDTO[] = [
  {
    id: '1',
    ownerId: 'owner-1',
    name: 'Family Photos',
    description: 'Our family collection',
    visibility: 'private',
    coverAssetId: null,
    coverUrl: null,
    assetCount: 10,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
  {
    id: '2',
    ownerId: 'owner-1',
    name: 'Vacation 2024',
    description: 'Summer vacation pics',
    visibility: 'shared',
    coverAssetId: null,
    coverUrl: null,
    assetCount: 25,
    createdAt: '2024-02-01T00:00:00Z',
    updatedAt: '2024-02-01T00:00:00Z',
  },
];

describe('LibraryGrid', () => {
  it('renders library cards', () => {
    render(<LibraryGrid libraries={mockLibraries} />);

    expect(screen.getByText('Family Photos')).toBeInTheDocument();
    expect(screen.getByText('Vacation 2024')).toBeInTheDocument();
  });

  it('renders correct number of cards', () => {
    render(<LibraryGrid libraries={mockLibraries} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
  });

  it('shows loading skeletons when isLoading and no libraries', () => {
    const { container } = render(<LibraryGrid libraries={[]} isLoading={true} />);

    // Skeletons are rendered via MUI Skeleton component
    const skeletons = container.querySelectorAll('.MuiSkeleton-root');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it('calls onLibraryClick when card is clicked', () => {
    const handleClick = vi.fn();
    render(<LibraryGrid libraries={mockLibraries} onLibraryClick={handleClick} />);

    const firstCard = screen.getByText('Family Photos').closest('button');
    if (firstCard) {
      fireEvent.click(firstCard);
    }

    expect(handleClick).toHaveBeenCalledWith(mockLibraries[0]);
  });

  it('does not show skeletons when libraries are loaded', () => {
    const { container } = render(<LibraryGrid libraries={mockLibraries} isLoading={false} />);

    const skeletons = container.querySelectorAll('.MuiSkeleton-root');
    expect(skeletons.length).toBe(0);
  });
});
