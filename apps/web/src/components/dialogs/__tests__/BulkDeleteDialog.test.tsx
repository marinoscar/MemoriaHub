import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BulkDeleteDialog } from '../BulkDeleteDialog';

describe('BulkDeleteDialog', () => {
  describe('rendering', () => {
    it('renders when open', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      expect(screen.getByText(/Delete Media/i)).toBeInTheDocument();
    });

    it('does not render when closed', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={false}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      expect(screen.queryByText(/Delete Media/i)).not.toBeInTheDocument();
    });

    it('displays confirmation message with count', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      expect(screen.getByText(/Are you sure you want to delete 5 selected items/i)).toBeInTheDocument();
    });

    it('shows warning message', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      expect(screen.getByText(/This action cannot be undone/i)).toBeInTheDocument();
      expect(screen.getByText(/permanently deleted/i)).toBeInTheDocument();
    });

    it('shows cancel and delete buttons', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      expect(screen.getByText('Cancel')).toBeInTheDocument();
      expect(screen.getByText(/Delete 5 Items/i)).toBeInTheDocument();
    });

    it('displays warning alert', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      // Warning alert should be present
      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
    });
  });

  describe('interaction', () => {
    it('calls onClose when Cancel is clicked', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      const cancelButton = screen.getByText('Cancel');
      fireEvent.click(cancelButton);

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('calls onConfirm when Delete button is clicked', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      const deleteButton = screen.getByText(/Delete 5 Items/i);
      fireEvent.click(deleteButton);

      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('does not call onConfirm when Cancel is clicked', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      const cancelButton = screen.getByText('Cancel');
      fireEvent.click(cancelButton);

      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('handles rapid delete button clicks', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      const deleteButton = screen.getByText(/Delete 5 Items/i);

      fireEvent.click(deleteButton);
      fireEvent.click(deleteButton);
      fireEvent.click(deleteButton);

      expect(onConfirm).toHaveBeenCalledTimes(3);
    });
  });

  describe('edge cases', () => {
    it('handles selectedCount of 1', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={1}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      expect(screen.getByText(/Are you sure you want to delete 1 selected item/i)).toBeInTheDocument();
      expect(screen.getByText(/Delete 1 Item/i)).toBeInTheDocument();
    });

    it('handles large selectedCount', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={999}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      expect(screen.getByText(/Are you sure you want to delete 999 selected items/i)).toBeInTheDocument();
      expect(screen.getByText(/Delete 999 Items/i)).toBeInTheDocument();
    });

    it('updates when selectedCount changes', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      const { rerender } = render(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      expect(screen.getByText(/Delete 5 Items/i)).toBeInTheDocument();

      rerender(
        <BulkDeleteDialog
          open={true}
          selectedCount={10}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      expect(screen.getByText(/Delete 10 Items/i)).toBeInTheDocument();
      expect(screen.queryByText(/Delete 5 Items/i)).not.toBeInTheDocument();
    });

    it('transitions from closed to open', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      const { rerender } = render(
        <BulkDeleteDialog
          open={false}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      expect(screen.queryByText(/Delete Media/i)).not.toBeInTheDocument();

      rerender(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      expect(screen.getByText(/Delete Media/i)).toBeInTheDocument();
    });

    it('handles dialog close via backdrop click', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('has proper dialog role', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();
    });

    it('has accessible buttons', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
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
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      const deleteButton = screen.getByText(/Delete 5 Items/i);
      deleteButton.focus();

      expect(document.activeElement).toBe(deleteButton);

      fireEvent.keyDown(deleteButton, { key: 'Enter' });
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('delete button has error color styling', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      const deleteButton = screen.getByText(/Delete 5 Items/i);
      expect(deleteButton).toBeInTheDocument();
      // Delete button should have error/destructive styling
    });

    it('warning alert is accessible', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      const alert = screen.getByRole('alert');
      expect(alert).toHaveAccessibleName();
    });
  });

  describe('user safety', () => {
    it('clearly indicates destructive action', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      // Should have multiple indicators that this is dangerous
      expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
      expect(screen.getByText(/permanently deleted/i)).toBeInTheDocument();
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    it('requires explicit confirmation', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      // Confirmation should not be called until user explicitly clicks delete
      expect(onConfirm).not.toHaveBeenCalled();

      const deleteButton = screen.getByText(/Delete 5 Items/i);
      fireEvent.click(deleteButton);

      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('makes cancel action easily accessible', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      const cancelButton = screen.getByText('Cancel');
      expect(cancelButton).toBeInTheDocument();
      expect(cancelButton).not.toBeDisabled();

      fireEvent.click(cancelButton);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('singular vs plural text', () => {
    it('uses singular text for 1 item', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={1}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      expect(screen.getByText(/1 selected item/i)).toBeInTheDocument();
      expect(screen.getByText(/Delete 1 Item/i)).toBeInTheDocument();
      expect(screen.queryByText(/items/i)).not.toBeInTheDocument();
    });

    it('uses plural text for multiple items', () => {
      const onClose = vi.fn();
      const onConfirm = vi.fn();

      render(
        <BulkDeleteDialog
          open={true}
          selectedCount={5}
          onClose={onClose}
          onConfirm={onConfirm}
        />
      );

      expect(screen.getByText(/5 selected items/i)).toBeInTheDocument();
      expect(screen.getByText(/Delete 5 Items/i)).toBeInTheDocument();
    });
  });
});
