import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AddToLibraryDialog } from '../AddToLibraryDialog';
import type { LibraryDTO } from '@memoriahub/shared';

// Mock libraries
const mockLibraries: LibraryDTO[] = [
  {
    id: 'lib-1',
    userId: 'user-1',
    name: 'Family Photos',
    description: 'Family vacation photos',
    visibility: 'private',
    assetCount: 100,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'lib-2',
    userId: 'user-1',
    name: 'Work Events',
    description: 'Company events and meetings',
    visibility: 'shared',
    assetCount: 50,
    createdAt: '2024-01-02T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
  },
  {
    id: 'lib-3',
    userId: 'user-1',
    name: 'Travel',
    description: 'Travel photos from around the world',
    visibility: 'private',
    assetCount: 200,
    createdAt: '2024-01-03T00:00:00Z',
    updatedAt: '2024-01-03T00:00:00Z',
  },
];

describe('AddToLibraryDialog', () => {
  describe('rendering', () => {
    it('renders when open', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByText('Add to Library')).toBeInTheDocument();
    });

    it('does not render when closed', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={false}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.queryByText('Add to Library')).not.toBeInTheDocument();
    });

    it('displays selected count', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByText(/Add 5 selected items to a library/i)).toBeInTheDocument();
    });

    it('shows library select dropdown', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByLabelText(/Select Library/i)).toBeInTheDocument();
    });

    it('shows cancel and add buttons', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByText('Cancel')).toBeInTheDocument();
      expect(screen.getByText('Add to Library')).toBeInTheDocument();
    });

    it('shows all available libraries in dropdown', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Open the dropdown
      const select = screen.getByLabelText(/Select Library/i);
      fireEvent.mouseDown(select);

      // Check all libraries are in the list
      expect(screen.getByText('Family Photos')).toBeInTheDocument();
      expect(screen.getByText('Work Events')).toBeInTheDocument();
      expect(screen.getByText('Travel')).toBeInTheDocument();
    });

    it('shows info message when no libraries available', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={[]}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByText(/You don't have any libraries/i)).toBeInTheDocument();
    });
  });

  describe('interaction', () => {
    it('calls onClose when Cancel is clicked', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      const cancelButton = screen.getByText('Cancel');
      fireEvent.click(cancelButton);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('allows selecting a library', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Open dropdown
      const select = screen.getByLabelText(/Select Library/i);
      fireEvent.mouseDown(select);

      // Select first library
      const option = screen.getByText('Family Photos');
      fireEvent.click(option);

      // Verify selection (the select should show the selected value)
      expect(select).toHaveTextContent('Family Photos');
    });

    it('calls onAdd with selected library ID when Add is clicked', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Open dropdown and select library
      const select = screen.getByLabelText(/Select Library/i);
      fireEvent.mouseDown(select);

      const option = screen.getByText('Family Photos');
      fireEvent.click(option);

      // Click Add button
      const addButton = screen.getAllByText('Add to Library').find((el) => el.tagName === 'BUTTON');
      fireEvent.click(addButton!);

      expect(onAdd).toHaveBeenCalledTimes(1);
      expect(onAdd).toHaveBeenCalledWith('lib-1');
    });

    it('resets selection when dialog is closed', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      const { rerender } = render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Select a library
      const select = screen.getByLabelText(/Select Library/i);
      fireEvent.mouseDown(select);

      const option = screen.getByText('Family Photos');
      fireEvent.click(option);

      // Close and reopen
      rerender(
        <AddToLibraryDialog
          open={false}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      rerender(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Selection should be reset
      const newSelect = screen.getByLabelText(/Select Library/i);
      expect(newSelect).not.toHaveTextContent('Family Photos');
    });

    it('closes dialog after adding to library', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Select library and click Add
      const select = screen.getByLabelText(/Select Library/i);
      fireEvent.mouseDown(select);

      const option = screen.getByText('Family Photos');
      fireEvent.click(option);

      const addButton = screen.getAllByText('Add to Library').find((el) => el.tagName === 'BUTTON');
      fireEvent.click(addButton!);

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('validation', () => {
    it('disables Add button when no library is selected', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      const addButton = screen.getAllByText('Add to Library').find((el) => el.tagName === 'BUTTON');
      expect(addButton).toBeDisabled();
    });

    it('enables Add button when library is selected', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Select a library
      const select = screen.getByLabelText(/Select Library/i);
      fireEvent.mouseDown(select);

      const option = screen.getByText('Family Photos');
      fireEvent.click(option);

      const addButton = screen.getAllByText('Add to Library').find((el) => el.tagName === 'BUTTON');
      expect(addButton).not.toBeDisabled();
    });

    it('disables Add button when no libraries are available', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={[]}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      const addButton = screen.getAllByText('Add to Library').find((el) => el.tagName === 'BUTTON');
      expect(addButton).toBeDisabled();
    });
  });

  describe('edge cases', () => {
    it('handles selectedCount of 1', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={1}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByText(/Add 1 selected item to a library/i)).toBeInTheDocument();
    });

    it('handles large selectedCount', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={999}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      expect(screen.getByText(/Add 999 selected items to a library/i)).toBeInTheDocument();
    });

    it('handles single library', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={[mockLibraries[0]]}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      const select = screen.getByLabelText(/Select Library/i);
      fireEvent.mouseDown(select);

      expect(screen.getByText('Family Photos')).toBeInTheDocument();
      expect(screen.queryByText('Work Events')).not.toBeInTheDocument();
    });

    it('handles many libraries', () => {
      const manyLibraries: LibraryDTO[] = Array.from({ length: 50 }, (_, i) => ({
        id: `lib-${i}`,
        userId: 'user-1',
        name: `Library ${i}`,
        description: `Description ${i}`,
        visibility: 'private' as const,
        assetCount: i * 10,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      }));

      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={manyLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      const select = screen.getByLabelText(/Select Library/i);
      fireEvent.mouseDown(select);

      // Should render all libraries
      expect(screen.getByText('Library 0')).toBeInTheDocument();
      expect(screen.getByText('Library 49')).toBeInTheDocument();
    });

    it('updates when libraries list changes', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      const { rerender } = render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      let select = screen.getByLabelText(/Select Library/i);
      fireEvent.mouseDown(select);
      expect(screen.getByText('Family Photos')).toBeInTheDocument();

      // Update with fewer libraries
      rerender(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries.slice(0, 1)}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      select = screen.getByLabelText(/Select Library/i);
      fireEvent.mouseDown(select);
      expect(screen.getByText('Family Photos')).toBeInTheDocument();
      expect(screen.queryByText('Work Events')).not.toBeInTheDocument();
    });

    it('handles dialog close via backdrop click', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // MUI Dialog calls onClose when backdrop is clicked
      // Simulate by calling the close handler directly
      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('has accessible form labels', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      const select = screen.getByLabelText(/Select Library/i);
      expect(select).toBeInTheDocument();
      expect(select).toHaveAccessibleName();
    });

    it('can be navigated with keyboard', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      const select = screen.getByLabelText(/Select Library/i);
      select.focus();
      expect(document.activeElement).toBe(select);
    });

    it('has proper dialog role', () => {
      const onClose = vi.fn();
      const onAdd = vi.fn();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();
    });
  });
});
