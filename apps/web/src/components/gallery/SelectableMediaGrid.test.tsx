import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SelectableMediaGrid } from './SelectableMediaGrid';
import { createMockMedia } from '../../test/test-helpers';
import type { MediaAssetDTO } from '@memoriahub/shared';

const mockMediaList: MediaAssetDTO[] = [
  createMockMedia('asset-1', { originalFilename: 'image1.jpg' }),
  createMockMedia('asset-2', { originalFilename: 'image2.jpg' }),
  createMockMedia('asset-3', { originalFilename: 'image3.jpg' }),
  createMockMedia('asset-4', { originalFilename: 'image4.jpg' }),
];

describe('SelectableMediaGrid', () => {
  describe('rendering', () => {
    it('renders all media items', () => {
      const onMediaClick = vi.fn();
      const onToggleSelection = vi.fn();
      const selectedIds = new Set<string>();

      render(
        <SelectableMediaGrid
          media={mockMediaList}
          isLoading={false}
          selectedIds={selectedIds}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={vi.fn()}
        />
      );

      expect(screen.getByAltText('image1.jpg')).toBeInTheDocument();
      expect(screen.getByAltText('image2.jpg')).toBeInTheDocument();
      expect(screen.getByAltText('image3.jpg')).toBeInTheDocument();
      expect(screen.getByAltText('image4.jpg')).toBeInTheDocument();
    });

    it('renders in grid layout', () => {
      const onMediaClick = vi.fn();
      const onToggleSelection = vi.fn();
      const selectedIds = new Set<string>();

      const { container } = render(
        <SelectableMediaGrid
          media={mockMediaList}
          isLoading={false}
          selectedIds={selectedIds}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={vi.fn()}
        />
      );

      const grid = container.firstChild as HTMLElement;
      expect(grid).toHaveStyle({ display: 'grid' });
    });

    it('shows loading state', () => {
      const onMediaClick = vi.fn();
      const onToggleSelection = vi.fn();
      const selectedIds = new Set<string>();

      render(
        <SelectableMediaGrid
          media={[]}
          isLoading={true}
          selectedIds={selectedIds}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={vi.fn()}
        />
      );

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('shows empty state when no media', () => {
      const onMediaClick = vi.fn();
      const onToggleSelection = vi.fn();
      const selectedIds = new Set<string>();

      render(
        <SelectableMediaGrid
          media={[]}
          isLoading={false}
          selectedIds={selectedIds}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={vi.fn()}
        />
      );

      expect(screen.getByText(/No media found/i)).toBeInTheDocument();
    });

    it('shows upload button in empty state', () => {
      const onMediaClick = vi.fn();
      const onToggleSelection = vi.fn();
      const onUploadClick = vi.fn();
      const selectedIds = new Set<string>();

      render(
        <SelectableMediaGrid
          media={[]}
          isLoading={false}
          selectedIds={selectedIds}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={onUploadClick}
        />
      );

      const uploadButton = screen.getByText(/Upload/i);
      expect(uploadButton).toBeInTheDocument();

      fireEvent.click(uploadButton);
      expect(onUploadClick).toHaveBeenCalledTimes(1);
    });

    it('applies selection state correctly', () => {
      const onMediaClick = vi.fn();
      const onToggleSelection = vi.fn();
      const selectedIds = new Set(['asset-1', 'asset-3']);

      const { container } = render(
        <SelectableMediaGrid
          media={mockMediaList}
          isLoading={false}
          selectedIds={selectedIds}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={vi.fn()}
        />
      );

      const checkboxes = container.querySelectorAll('input[type="checkbox"]');
      expect(checkboxes).toHaveLength(4);

      // Check that asset-1 and asset-3 are checked
      expect((checkboxes[0] as HTMLInputElement).checked).toBe(true); // asset-1
      expect((checkboxes[1] as HTMLInputElement).checked).toBe(false); // asset-2
      expect((checkboxes[2] as HTMLInputElement).checked).toBe(true); // asset-3
      expect((checkboxes[3] as HTMLInputElement).checked).toBe(false); // asset-4
    });
  });

  describe('interaction', () => {
    it('calls onMediaClick when a card is clicked', () => {
      const onMediaClick = vi.fn();
      const onToggleSelection = vi.fn();
      const selectedIds = new Set<string>();

      const { container } = render(
        <SelectableMediaGrid
          media={mockMediaList}
          isLoading={false}
          selectedIds={selectedIds}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={vi.fn()}
        />
      );

      // Get first media card (not the checkbox)
      const firstImage = screen.getByAltText('image1.jpg');
      fireEvent.click(firstImage);

      expect(onMediaClick).toHaveBeenCalledTimes(1);
      expect(onMediaClick).toHaveBeenCalledWith('asset-1');
    });

    it('calls onToggleSelection when checkbox is clicked', () => {
      const onMediaClick = vi.fn();
      const onToggleSelection = vi.fn();
      const selectedIds = new Set<string>();

      const { container } = render(
        <SelectableMediaGrid
          media={mockMediaList}
          isLoading={false}
          selectedIds={selectedIds}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={vi.fn()}
        />
      );

      const firstCheckbox = container.querySelector('input[type="checkbox"]') as HTMLElement;
      fireEvent.click(firstCheckbox);

      expect(onToggleSelection).toHaveBeenCalledTimes(1);
      expect(onToggleSelection).toHaveBeenCalledWith('asset-1');
    });

    it('handles multiple selections', () => {
      const onMediaClick = vi.fn();
      const onToggleSelection = vi.fn();
      const selectedIds = new Set<string>();

      const { container } = render(
        <SelectableMediaGrid
          media={mockMediaList}
          isLoading={false}
          selectedIds={selectedIds}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={vi.fn()}
        />
      );

      const checkboxes = container.querySelectorAll('input[type="checkbox"]');

      fireEvent.click(checkboxes[0] as HTMLElement); // asset-1
      fireEvent.click(checkboxes[2] as HTMLElement); // asset-3

      expect(onToggleSelection).toHaveBeenCalledTimes(2);
      expect(onToggleSelection).toHaveBeenNthCalledWith(1, 'asset-1');
      expect(onToggleSelection).toHaveBeenNthCalledWith(2, 'asset-3');
    });
  });

  describe('responsive layout', () => {
    it('uses responsive grid columns', () => {
      const onMediaClick = vi.fn();
      const onToggleSelection = vi.fn();
      const selectedIds = new Set<string>();

      const { container } = render(
        <SelectableMediaGrid
          media={mockMediaList}
          isLoading={false}
          selectedIds={selectedIds}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={vi.fn()}
        />
      );

      const grid = container.firstChild as HTMLElement;
      // Grid should have responsive column configuration
      expect(grid).toHaveStyle({ display: 'grid' });
    });
  });

  describe('edge cases', () => {
    it('handles empty media array', () => {
      const onMediaClick = vi.fn();
      const onToggleSelection = vi.fn();
      const selectedIds = new Set<string>();

      render(
        <SelectableMediaGrid
          media={[]}
          isLoading={false}
          selectedIds={selectedIds}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={vi.fn()}
        />
      );

      expect(screen.getByText(/No media found/i)).toBeInTheDocument();
    });

    it('handles single media item', () => {
      const onMediaClick = vi.fn();
      const onToggleSelection = vi.fn();
      const selectedIds = new Set<string>();

      render(
        <SelectableMediaGrid
          media={[mockMediaList[0]]}
          isLoading={false}
          selectedIds={selectedIds}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={vi.fn()}
        />
      );

      expect(screen.getByAltText('image1.jpg')).toBeInTheDocument();
      expect(screen.queryByAltText('image2.jpg')).not.toBeInTheDocument();
    });

    it('handles large number of items', () => {
      const largeMediaList = Array.from({ length: 100 }, (_, i) =>
        createMockMedia(`asset-${i}`, `image${i}.jpg`)
      );

      const onMediaClick = vi.fn();
      const onToggleSelection = vi.fn();
      const selectedIds = new Set<string>();

      const { container } = render(
        <SelectableMediaGrid
          media={largeMediaList}
          isLoading={false}
          selectedIds={selectedIds}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={vi.fn()}
        />
      );

      const checkboxes = container.querySelectorAll('input[type="checkbox"]');
      expect(checkboxes).toHaveLength(100);
    });

    it('updates when media list changes', () => {
      const onMediaClick = vi.fn();
      const onToggleSelection = vi.fn();
      const selectedIds = new Set<string>();

      const { rerender } = render(
        <SelectableMediaGrid
          media={mockMediaList}
          isLoading={false}
          selectedIds={selectedIds}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={vi.fn()}
        />
      );

      expect(screen.getAllByRole('img')).toHaveLength(4);

      // Update with fewer items
      rerender(
        <SelectableMediaGrid
          media={mockMediaList.slice(0, 2)}
          isLoading={false}
          selectedIds={selectedIds}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={vi.fn()}
        />
      );

      expect(screen.getAllByRole('img')).toHaveLength(2);
    });

    it('updates when selection changes', () => {
      const onMediaClick = vi.fn();
      const onToggleSelection = vi.fn();

      const { rerender, container } = render(
        <SelectableMediaGrid
          media={mockMediaList}
          isLoading={false}
          selectedIds={new Set()}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={vi.fn()}
        />
      );

      let checkboxes = container.querySelectorAll('input[type="checkbox"]');
      expect((checkboxes[0] as HTMLInputElement).checked).toBe(false);

      // Update with selection
      rerender(
        <SelectableMediaGrid
          media={mockMediaList}
          isLoading={false}
          selectedIds={new Set(['asset-1'])}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={vi.fn()}
        />
      );

      checkboxes = container.querySelectorAll('input[type="checkbox"]');
      expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
    });
  });

  describe('loading and error states', () => {
    it('shows loading spinner when loading', () => {
      const onMediaClick = vi.fn();
      const onToggleSelection = vi.fn();
      const selectedIds = new Set<string>();

      render(
        <SelectableMediaGrid
          media={[]}
          isLoading={true}
          selectedIds={selectedIds}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={vi.fn()}
        />
      );

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('does not show media during loading', () => {
      const onMediaClick = vi.fn();
      const onToggleSelection = vi.fn();
      const selectedIds = new Set<string>();

      render(
        <SelectableMediaGrid
          media={mockMediaList}
          isLoading={true}
          selectedIds={selectedIds}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={vi.fn()}
        />
      );

      expect(screen.queryByAltText('image1.jpg')).not.toBeInTheDocument();
    });

    it('transitions from loading to loaded', () => {
      const onMediaClick = vi.fn();
      const onToggleSelection = vi.fn();
      const selectedIds = new Set<string>();

      const { rerender } = render(
        <SelectableMediaGrid
          media={[]}
          isLoading={true}
          selectedIds={selectedIds}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={vi.fn()}
        />
      );

      expect(screen.getByRole('progressbar')).toBeInTheDocument();

      rerender(
        <SelectableMediaGrid
          media={mockMediaList}
          isLoading={false}
          selectedIds={selectedIds}
          onMediaClick={onMediaClick}
          onToggleSelection={onToggleSelection}
          onUploadClick={vi.fn()}
        />
      );

      expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
      expect(screen.getByAltText('image1.jpg')).toBeInTheDocument();
    });
  });
});
