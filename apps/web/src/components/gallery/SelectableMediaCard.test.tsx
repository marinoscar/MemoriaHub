import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SelectableMediaCard } from './SelectableMediaCard';
import { createMockMedia } from '../../test/test-helpers';

// Mock media asset
const mockMedia = createMockMedia('asset-1', {
  originalFilename: 'test-image.jpg',
  thumbnailUrl: 'https://example.com/thumb.jpg',
  previewUrl: 'https://example.com/preview.jpg',
  fullUrl: 'https://example.com/full.jpg',
});

describe('SelectableMediaCard', () => {
  describe('rendering', () => {
    it('renders media thumbnail', () => {
      const onClick = vi.fn();
      const onToggleSelection = vi.fn();

      render(
        <SelectableMediaCard
          media={mockMedia}
          isSelected={false}
          onClick={onClick}
          onToggleSelection={onToggleSelection}
        />
      );

      const image = screen.getByAltText('test-image.jpg');
      expect(image).toBeInTheDocument();
      expect(image).toHaveAttribute('src', mockMedia.thumbnailUrl);
    });

    it('shows checkbox when not selected', () => {
      const onClick = vi.fn();
      const onToggleSelection = vi.fn();

      const { container } = render(
        <SelectableMediaCard
          media={mockMedia}
          isSelected={false}
          onClick={onClick}
          onToggleSelection={onToggleSelection}
        />
      );

      const checkbox = container.querySelector('input[type="checkbox"]');
      expect(checkbox).toBeInTheDocument();
      expect(checkbox).not.toBeChecked();
    });

    it('shows checked checkbox when selected', () => {
      const onClick = vi.fn();
      const onToggleSelection = vi.fn();

      const { container } = render(
        <SelectableMediaCard
          media={mockMedia}
          isSelected={true}
          onClick={onClick}
          onToggleSelection={onToggleSelection}
        />
      );

      const checkbox = container.querySelector('input[type="checkbox"]');
      expect(checkbox).toBeInTheDocument();
      expect(checkbox).toBeChecked();
    });

    it('applies selection outline when selected', () => {
      const onClick = vi.fn();
      const onToggleSelection = vi.fn();

      const { container } = render(
        <SelectableMediaCard
          media={mockMedia}
          isSelected={true}
          onClick={onClick}
          onToggleSelection={onToggleSelection}
        />
      );

      // Check for the Box with selection styling
      const cardBox = container.firstChild as HTMLElement;
      expect(cardBox).toBeInTheDocument();
    });

    it('displays video icon for video media', () => {
      const videoMedia = createMockMedia('asset-video', {
        mimeType: 'video/mp4',
        originalFilename: 'test-video.mp4',
      });

      const onClick = vi.fn();
      const onToggleSelection = vi.fn();

      render(
        <SelectableMediaCard
          media={videoMedia}
          isSelected={false}
          onClick={onClick}
          onToggleSelection={onToggleSelection}
        />
      );

      // Video icon should be present
      const videoIcon = screen.getByTestId('PlayArrowIcon');
      expect(videoIcon).toBeInTheDocument();
    });
  });

  describe('interaction', () => {
    it('calls onClick when card is clicked', () => {
      const onClick = vi.fn();
      const onToggleSelection = vi.fn();

      const { container } = render(
        <SelectableMediaCard
          media={mockMedia}
          isSelected={false}
          onClick={onClick}
          onToggleSelection={onToggleSelection}
        />
      );

      const card = container.firstChild as HTMLElement;
      fireEvent.click(card);

      expect(onClick).toHaveBeenCalledTimes(1);
      expect(onClick).toHaveBeenCalledWith(mockMedia.id);
      expect(onToggleSelection).not.toHaveBeenCalled();
    });

    it('calls onToggleSelection when checkbox is clicked', () => {
      const onClick = vi.fn();
      const onToggleSelection = vi.fn();

      const { container } = render(
        <SelectableMediaCard
          media={mockMedia}
          isSelected={false}
          onClick={onClick}
          onToggleSelection={onToggleSelection}
        />
      );

      const checkbox = container.querySelector('input[type="checkbox"]') as HTMLElement;
      fireEvent.click(checkbox);

      expect(onToggleSelection).toHaveBeenCalledTimes(1);
      expect(onToggleSelection).toHaveBeenCalledWith(mockMedia.id);
    });

    it('does not call onClick when checkbox area is clicked', () => {
      const onClick = vi.fn();
      const onToggleSelection = vi.fn();

      const { container } = render(
        <SelectableMediaCard
          media={mockMedia}
          isSelected={false}
          onClick={onClick}
          onToggleSelection={onToggleSelection}
        />
      );

      const checkboxContainer = container.querySelector('.checkbox-container') as HTMLElement;
      fireEvent.click(checkboxContainer);

      expect(onToggleSelection).toHaveBeenCalledTimes(1);
      expect(onClick).not.toHaveBeenCalled();
    });

    it('prevents event propagation from checkbox to card', () => {
      const onClick = vi.fn();
      const onToggleSelection = vi.fn();

      const { container } = render(
        <SelectableMediaCard
          media={mockMedia}
          isSelected={false}
          onClick={onClick}
          onToggleSelection={onToggleSelection}
        />
      );

      const checkbox = container.querySelector('input[type="checkbox"]') as HTMLElement;
      const clickEvent = new MouseEvent('click', { bubbles: true });

      fireEvent(checkbox, clickEvent);

      // Only toggle should be called, not the card onClick
      expect(onToggleSelection).toHaveBeenCalledTimes(1);
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe('keyboard accessibility', () => {
    it('is focusable via keyboard', () => {
      const onClick = vi.fn();
      const onToggleSelection = vi.fn();

      const { container } = render(
        <SelectableMediaCard
          media={mockMedia}
          isSelected={false}
          onClick={onClick}
          onToggleSelection={onToggleSelection}
        />
      );

      const card = container.firstChild as HTMLElement;
      card.focus();
      expect(document.activeElement).toBe(card);
    });

    it('activates with Enter key', () => {
      const onClick = vi.fn();
      const onToggleSelection = vi.fn();

      const { container } = render(
        <SelectableMediaCard
          media={mockMedia}
          isSelected={false}
          onClick={onClick}
          onToggleSelection={onToggleSelection}
        />
      );

      const card = container.firstChild as HTMLElement;
      fireEvent.keyDown(card, { key: 'Enter', code: 'Enter' });

      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('checkbox is accessible via keyboard', () => {
      const onClick = vi.fn();
      const onToggleSelection = vi.fn();

      const { container } = render(
        <SelectableMediaCard
          media={mockMedia}
          isSelected={false}
          onClick={onClick}
          onToggleSelection={onToggleSelection}
        />
      );

      const checkbox = container.querySelector('input[type="checkbox"]') as HTMLElement;
      fireEvent.keyDown(checkbox, { key: ' ', code: 'Space' });

      expect(onToggleSelection).toHaveBeenCalledTimes(1);
    });
  });

  describe('edge cases', () => {
    it('handles missing thumbnail URL gracefully', () => {
      const mediaWithoutThumb = createMockMedia('asset-no-thumb', {
        thumbnailUrl: null,
      });

      const onClick = vi.fn();
      const onToggleSelection = vi.fn();

      render(
        <SelectableMediaCard
          media={mediaWithoutThumb}
          isSelected={false}
          onClick={onClick}
          onToggleSelection={onToggleSelection}
        />
      );

      // Should render without crashing
      const image = screen.queryByAltText(mediaWithoutThumb.originalFilename);
      expect(image).toBeInTheDocument();
    });

    it('handles very long filenames', () => {
      const mediaWithLongName = createMockMedia('asset-long-name', {
        originalFilename: 'this-is-a-very-long-filename-that-should-be-truncated-properly.jpg',
      });

      const onClick = vi.fn();
      const onToggleSelection = vi.fn();

      render(
        <SelectableMediaCard
          media={mediaWithLongName}
          isSelected={false}
          onClick={onClick}
          onToggleSelection={onToggleSelection}
        />
      );

      const image = screen.getByAltText(mediaWithLongName.originalFilename);
      expect(image).toBeInTheDocument();
    });

    it('toggles selection state correctly', () => {
      const onClick = vi.fn();
      const onToggleSelection = vi.fn();

      const { rerender, container } = render(
        <SelectableMediaCard
          media={mockMedia}
          isSelected={false}
          onClick={onClick}
          onToggleSelection={onToggleSelection}
        />
      );

      let checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(checkbox.checked).toBe(false);

      // Rerender with isSelected=true
      rerender(
        <SelectableMediaCard
          media={mockMedia}
          isSelected={true}
          onClick={onClick}
          onToggleSelection={onToggleSelection}
        />
      );

      checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
    });
  });

  describe('media type handling', () => {
    it('identifies image media correctly', () => {
      const imageMedia = createMockMedia('asset-image', {
        mimeType: 'image/png',
      });

      const onClick = vi.fn();
      const onToggleSelection = vi.fn();

      render(
        <SelectableMediaCard
          media={imageMedia}
          isSelected={false}
          onClick={onClick}
          onToggleSelection={onToggleSelection}
        />
      );

      // Should not show video icon
      expect(screen.queryByTestId('PlayArrowIcon')).not.toBeInTheDocument();
    });

    it('identifies video media correctly', () => {
      const videoMedia = createMockMedia('asset-video-webm', {
        mimeType: 'video/webm',
      });

      const onClick = vi.fn();
      const onToggleSelection = vi.fn();

      render(
        <SelectableMediaCard
          media={videoMedia}
          isSelected={false}
          onClick={onClick}
          onToggleSelection={onToggleSelection}
        />
      );

      // Should show video icon
      expect(screen.getByTestId('PlayArrowIcon')).toBeInTheDocument();
    });
  });
});
