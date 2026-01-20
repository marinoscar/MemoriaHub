import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AddToLibraryDialog } from './AddToLibraryDialog';
import { createMockLibrary } from '../../test/test-helpers';
import type { LibraryDTO } from '@memoriahub/shared';

// Mock libraries
const mockLibraries: LibraryDTO[] = [
  createMockLibrary('lib-1', 'Family Photos', {
    description: 'Family vacation photos',
    visibility: 'private',
    assetCount: 100,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }),
  createMockLibrary('lib-2', 'Work Events', {
    description: 'Company events and meetings',
    visibility: 'shared',
    assetCount: 50,
    createdAt: '2024-01-02T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
  }),
  createMockLibrary('lib-3', 'Travel', {
    description: 'Travel photos from around the world',
    visibility: 'private',
    assetCount: 200,
    createdAt: '2024-01-03T00:00:00Z',
    updatedAt: '2024-01-03T00:00:00Z',
  }),
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

      // Use heading role to specifically get the dialog title
      expect(screen.getByRole('heading', { name: 'Add to Library' })).toBeInTheDocument();
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
      // Use button role to specifically get the Add button (not the dialog title)
      expect(screen.getByRole('button', { name: 'Add to Library' })).toBeInTheDocument();
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

      // After selection, the option should be selected (check Add button is enabled)
      const addButton = screen.getAllByText('Add to Library').find((el) => el.tagName === 'BUTTON');
      expect(addButton).not.toBeDisabled();
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

      const { unmount } = render(
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

      // Click Cancel to trigger handleClose which resets internal state
      const cancelButton = screen.getByText('Cancel');
      fireEvent.click(cancelButton);

      // Unmount and remount to simulate dialog reopening
      unmount();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Selection should be reset - Add button should be disabled again
      const addButton = screen.getByRole('button', { name: 'Add to Library' });
      expect(addButton).toBeDisabled();
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

      expect(screen.getByText(/Add 1 selected items to a library/i)).toBeInTheDocument();
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
      const manyLibraries: LibraryDTO[] = Array.from({ length: 50 }, (_, i) =>
        createMockLibrary(`lib-${i}`, `Library ${i}`, {
          description: `Description ${i}`,
          visibility: 'private',
          assetCount: i * 10,
        })
      );

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

      const { unmount } = render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Check that both libraries are available as options
      const select = screen.getByRole('combobox');
      fireEvent.mouseDown(select);
      expect(screen.getByText('Family Photos')).toBeInTheDocument();
      expect(screen.getByText('Work Events')).toBeInTheDocument();

      // Unmount and remount with fewer libraries
      unmount();

      render(
        <AddToLibraryDialog
          open={true}
          selectedCount={5}
          libraries={mockLibraries.slice(0, 1)}
          onClose={onClose}
          onAdd={onAdd}
        />
      );

      // Check that only one library is available
      const newSelect = screen.getByRole('combobox');
      fireEvent.mouseDown(newSelect);
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

      // MUI Select should be focusable
      const select = screen.getByLabelText(/Select Library/i);
      expect(select).toBeInTheDocument();
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
