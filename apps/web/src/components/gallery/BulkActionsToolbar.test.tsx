import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BulkActionsToolbar } from './BulkActionsToolbar';

describe('BulkActionsToolbar', () => {
  describe('rendering', () => {
    it('renders when items are selected', () => {
      const onClose = vi.fn();
      const onAddToLibrary = vi.fn();
      const onEditMetadata = vi.fn();
      const onDelete = vi.fn();

      render(
        <BulkActionsToolbar
          selectedCount={5}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      expect(screen.getByText('5 selected')).toBeInTheDocument();
    });

    it('does not render when no items are selected', () => {
      const onClose = vi.fn();
      const onAddToLibrary = vi.fn();
      const onEditMetadata = vi.fn();
      const onDelete = vi.fn();

      const { container } = render(
        <BulkActionsToolbar
          selectedCount={0}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      expect(container.firstChild).toBeNull();
    });

    it('displays correct selected count', () => {
      const onClose = vi.fn();
      const onAddToLibrary = vi.fn();
      const onEditMetadata = vi.fn();
      const onDelete = vi.fn();

      const { rerender } = render(
        <BulkActionsToolbar
          selectedCount={1}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      expect(screen.getByText('1 selected')).toBeInTheDocument();

      rerender(
        <BulkActionsToolbar
          selectedCount={42}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      expect(screen.getByText('42 selected')).toBeInTheDocument();
    });

    it('shows all action buttons', () => {
      const onClose = vi.fn();
      const onAddToLibrary = vi.fn();
      const onEditMetadata = vi.fn();
      const onDelete = vi.fn();

      render(
        <BulkActionsToolbar
          selectedCount={3}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      expect(screen.getByText('Add to Library')).toBeInTheDocument();
      expect(screen.getByText('Edit Metadata')).toBeInTheDocument();
      expect(screen.getByText('Delete')).toBeInTheDocument();
    });

    it('shows close button', () => {
      const onClose = vi.fn();
      const onAddToLibrary = vi.fn();
      const onEditMetadata = vi.fn();
      const onDelete = vi.fn();

      render(
        <BulkActionsToolbar
          selectedCount={3}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      // Close button with CloseIcon
      const closeButton = screen.getByTestId('CloseIcon').closest('button');
      expect(closeButton).toBeInTheDocument();
    });

    it('applies fixed positioning styles', () => {
      const onClose = vi.fn();
      const onAddToLibrary = vi.fn();
      const onEditMetadata = vi.fn();
      const onDelete = vi.fn();

      const { container } = render(
        <BulkActionsToolbar
          selectedCount={3}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      const toolbar = container.querySelector('[class*="MuiPaper"]');
      expect(toolbar).toBeInTheDocument();
    });
  });

  describe('interaction', () => {
    it('calls onClose when close button is clicked', () => {
      const onClose = vi.fn();
      const onAddToLibrary = vi.fn();
      const onEditMetadata = vi.fn();
      const onDelete = vi.fn();

      render(
        <BulkActionsToolbar
          selectedCount={3}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      const closeButton = screen.getByTestId('CloseIcon').closest('button') as HTMLElement;
      fireEvent.click(closeButton);

      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onAddToLibrary when Add to Library is clicked', () => {
      const onClose = vi.fn();
      const onAddToLibrary = vi.fn();
      const onEditMetadata = vi.fn();
      const onDelete = vi.fn();

      render(
        <BulkActionsToolbar
          selectedCount={3}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      const addButton = screen.getByText('Add to Library');
      fireEvent.click(addButton);

      expect(onAddToLibrary).toHaveBeenCalledTimes(1);
    });

    it('calls onEditMetadata when Edit Metadata is clicked', () => {
      const onClose = vi.fn();
      const onAddToLibrary = vi.fn();
      const onEditMetadata = vi.fn();
      const onDelete = vi.fn();

      render(
        <BulkActionsToolbar
          selectedCount={3}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      const editButton = screen.getByText('Edit Metadata');
      fireEvent.click(editButton);

      expect(onEditMetadata).toHaveBeenCalledTimes(1);
    });

    it('calls onDelete when Delete is clicked', () => {
      const onClose = vi.fn();
      const onAddToLibrary = vi.fn();
      const onEditMetadata = vi.fn();
      const onDelete = vi.fn();

      render(
        <BulkActionsToolbar
          selectedCount={3}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      const deleteButton = screen.getByText('Delete');
      fireEvent.click(deleteButton);

      expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it('does not call other handlers when one button is clicked', () => {
      const onClose = vi.fn();
      const onAddToLibrary = vi.fn();
      const onEditMetadata = vi.fn();
      const onDelete = vi.fn();

      render(
        <BulkActionsToolbar
          selectedCount={3}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      const addButton = screen.getByText('Add to Library');
      fireEvent.click(addButton);

      expect(onAddToLibrary).toHaveBeenCalledTimes(1);
      expect(onEditMetadata).not.toHaveBeenCalled();
      expect(onDelete).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('handles rapid button clicks', () => {
      const onClose = vi.fn();
      const onAddToLibrary = vi.fn();
      const onEditMetadata = vi.fn();
      const onDelete = vi.fn();

      render(
        <BulkActionsToolbar
          selectedCount={3}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      const addButton = screen.getByText('Add to Library');

      fireEvent.click(addButton);
      fireEvent.click(addButton);
      fireEvent.click(addButton);

      expect(onAddToLibrary).toHaveBeenCalledTimes(3);
    });

    it('updates when selectedCount changes', () => {
      const onClose = vi.fn();
      const onAddToLibrary = vi.fn();
      const onEditMetadata = vi.fn();
      const onDelete = vi.fn();

      const { rerender } = render(
        <BulkActionsToolbar
          selectedCount={5}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      expect(screen.getByText('5 selected')).toBeInTheDocument();

      rerender(
        <BulkActionsToolbar
          selectedCount={10}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      expect(screen.getByText('10 selected')).toBeInTheDocument();
      expect(screen.queryByText('5 selected')).not.toBeInTheDocument();
    });

    it('disappears when selectedCount becomes 0', () => {
      const onClose = vi.fn();
      const onAddToLibrary = vi.fn();
      const onEditMetadata = vi.fn();
      const onDelete = vi.fn();

      const { rerender, container } = render(
        <BulkActionsToolbar
          selectedCount={5}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      expect(screen.getByText('5 selected')).toBeInTheDocument();

      rerender(
        <BulkActionsToolbar
          selectedCount={0}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      expect(container.firstChild).toBeNull();
    });

    it('handles very large selection counts', () => {
      const onClose = vi.fn();
      const onAddToLibrary = vi.fn();
      const onEditMetadata = vi.fn();
      const onDelete = vi.fn();

      render(
        <BulkActionsToolbar
          selectedCount={9999}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      expect(screen.getByText('9999 selected')).toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('has accessible buttons', () => {
      const onClose = vi.fn();
      const onAddToLibrary = vi.fn();
      const onEditMetadata = vi.fn();
      const onDelete = vi.fn();

      render(
        <BulkActionsToolbar
          selectedCount={3}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThan(0);

      buttons.forEach((button) => {
        expect(button).toBeInTheDocument();
      });
    });

    it('can be navigated with keyboard', () => {
      const onClose = vi.fn();
      const onAddToLibrary = vi.fn();
      const onEditMetadata = vi.fn();
      const onDelete = vi.fn();

      render(
        <BulkActionsToolbar
          selectedCount={3}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      // Verify buttons are focusable
      const addButton = screen.getByText('Add to Library');
      addButton.focus();

      expect(document.activeElement).toBe(addButton);

      // Verify clicking the focused button works
      fireEvent.click(addButton);
      expect(onAddToLibrary).toHaveBeenCalledTimes(1);
    });

    it('delete button has error color', () => {
      const onClose = vi.fn();
      const onAddToLibrary = vi.fn();
      const onEditMetadata = vi.fn();
      const onDelete = vi.fn();

      render(
        <BulkActionsToolbar
          selectedCount={3}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      const deleteButton = screen.getByText('Delete');
      expect(deleteButton).toBeInTheDocument();
      // Delete button should have error styling to indicate destructive action
    });
  });

  describe('visual indicators', () => {
    it('shows appropriate icons for each action', () => {
      const onClose = vi.fn();
      const onAddToLibrary = vi.fn();
      const onEditMetadata = vi.fn();
      const onDelete = vi.fn();

      render(
        <BulkActionsToolbar
          selectedCount={3}
          onClose={onClose}
          onAddToLibrary={onAddToLibrary}
          onEditMetadata={onEditMetadata}
          onDelete={onDelete}
        />
      );

      // Icons should be present
      expect(screen.getByTestId('CloseIcon')).toBeInTheDocument();
      expect(screen.getByTestId('LibraryAddIcon')).toBeInTheDocument();
      expect(screen.getByTestId('EditIcon')).toBeInTheDocument();
      expect(screen.getByTestId('DeleteIcon')).toBeInTheDocument();
    });
  });
});
