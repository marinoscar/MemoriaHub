import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '../../test/utils';
import { GalleryFilters, type FilterState } from './GalleryFilters';

const defaultFilters: FilterState = {
  mediaType: 'all',
  sortBy: 'capturedAt',
  sortOrder: 'desc',
};

describe('GalleryFilters', () => {
  it('renders media type toggle buttons', () => {
    render(<GalleryFilters filters={defaultFilters} onFilterChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: /all media/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /images only/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /videos only/i })).toBeInTheDocument();
  });

  it('renders sort by select', () => {
    render(<GalleryFilters filters={defaultFilters} onFilterChange={vi.fn()} />);

    expect(screen.getByLabelText(/sort by/i)).toBeInTheDocument();
  });

  it('calls onFilterChange when media type is changed', () => {
    const handleChange = vi.fn();
    render(<GalleryFilters filters={defaultFilters} onFilterChange={handleChange} />);

    const imagesButton = screen.getByRole('button', { name: /images only/i });
    fireEvent.click(imagesButton);

    expect(handleChange).toHaveBeenCalledWith({
      ...defaultFilters,
      mediaType: 'image',
    });
  });

  it('calls onFilterChange when sort order is toggled', () => {
    const handleChange = vi.fn();
    render(<GalleryFilters filters={defaultFilters} onFilterChange={handleChange} />);

    const sortOrderButton = screen.getByRole('button', { name: /newest first/i });
    fireEvent.click(sortOrderButton);

    expect(handleChange).toHaveBeenCalledWith({
      ...defaultFilters,
      sortOrder: 'asc',
    });
  });

  it('shows correct sort order icon (desc = newest first)', () => {
    render(<GalleryFilters filters={defaultFilters} onFilterChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: /newest first/i })).toBeInTheDocument();
  });

  it('shows correct sort order icon (asc = oldest first)', () => {
    const ascFilters: FilterState = { ...defaultFilters, sortOrder: 'asc' };
    render(<GalleryFilters filters={ascFilters} onFilterChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: /oldest first/i })).toBeInTheDocument();
  });

  it('has correct button selected for current filter', () => {
    const imageFilters: FilterState = { ...defaultFilters, mediaType: 'image' };
    render(<GalleryFilters filters={imageFilters} onFilterChange={vi.fn()} />);

    const imagesButton = screen.getByRole('button', { name: /images only/i });
    expect(imagesButton).toHaveAttribute('aria-pressed', 'true');
  });
});
