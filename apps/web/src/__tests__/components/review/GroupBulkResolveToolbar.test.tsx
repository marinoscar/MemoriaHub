/**
 * Unit tests for GroupBulkResolveToolbar.
 *
 * Covers:
 *  - Renders nothing when selectedIds is empty
 *  - Renders the selection count and both action buttons when a selection exists
 *  - "Resolve & Delete" is hidden when canTrash=false
 *  - Clicking "Resolve & Archive" for a small selection calls onResolve('archive')
 *    directly (no confirm dialog)
 *  - Clicking "Resolve & Delete" ALWAYS opens a confirm dialog, even for a
 *    single-item selection, and only calls onResolve('trash') after confirming
 *  - A large (>25) archive selection also requires confirmation
 *  - Cancel closes the dialog without calling onResolve
 *  - onClear / onSelectAll wire to their respective icon buttons
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { GroupBulkResolveToolbar } from '../../../components/review/GroupBulkResolveToolbar';

function makeSelection(count: number): Set<string> {
  return new Set(Array.from({ length: count }, (_, i) => `id-${i}`));
}

describe('GroupBulkResolveToolbar', () => {
  describe('empty selection', () => {
    it('renders nothing when selectedIds is empty', () => {
      const { container } = render(
        <GroupBulkResolveToolbar
          selectedIds={new Set()}
          onClear={vi.fn()}
          onSelectAll={vi.fn()}
          onResolve={vi.fn().mockResolvedValue(undefined)}
          canTrash
        />,
      );

      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('with a selection', () => {
    it('renders the selection count', () => {
      render(
        <GroupBulkResolveToolbar
          selectedIds={makeSelection(3)}
          onClear={vi.fn()}
          onSelectAll={vi.fn()}
          onResolve={vi.fn().mockResolvedValue(undefined)}
          canTrash
        />,
      );

      expect(screen.getByText('3 selected')).toBeInTheDocument();
    });

    it('renders both "Resolve & Archive" and "Resolve & Delete" when canTrash=true', () => {
      render(
        <GroupBulkResolveToolbar
          selectedIds={makeSelection(1)}
          onClear={vi.fn()}
          onSelectAll={vi.fn()}
          onResolve={vi.fn().mockResolvedValue(undefined)}
          canTrash
        />,
      );

      expect(screen.getByRole('button', { name: /resolve.*archive/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /resolve.*delete/i })).toBeInTheDocument();
    });

    it('hides "Resolve & Delete" when canTrash=false', () => {
      render(
        <GroupBulkResolveToolbar
          selectedIds={makeSelection(1)}
          onClear={vi.fn()}
          onSelectAll={vi.fn()}
          onResolve={vi.fn().mockResolvedValue(undefined)}
          canTrash={false}
        />,
      );

      expect(screen.getByRole('button', { name: /resolve.*archive/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /resolve.*delete/i })).toBeNull();
    });
  });

  describe('archive action (small selection)', () => {
    it('calls onResolve("archive") directly without a confirm dialog', async () => {
      const user = userEvent.setup();
      const onResolve = vi.fn().mockResolvedValue(undefined);

      render(
        <GroupBulkResolveToolbar
          selectedIds={makeSelection(3)}
          onClear={vi.fn()}
          onSelectAll={vi.fn()}
          onResolve={onResolve}
          canTrash
        />,
      );

      await user.click(screen.getByRole('button', { name: /resolve.*archive/i }));

      await waitFor(() => {
        expect(onResolve).toHaveBeenCalledWith('archive');
      });
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  describe('trash action', () => {
    it('always opens a confirm dialog, even for a single selected group', async () => {
      const user = userEvent.setup();
      const onResolve = vi.fn().mockResolvedValue(undefined);

      render(
        <GroupBulkResolveToolbar
          selectedIds={makeSelection(1)}
          onClear={vi.fn()}
          onSelectAll={vi.fn()}
          onResolve={onResolve}
          canTrash
        />,
      );

      await user.click(screen.getByRole('button', { name: /resolve.*delete/i }));

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });
      expect(onResolve).not.toHaveBeenCalled();
    });

    it('calls onResolve("trash") only after the dialog is confirmed', async () => {
      const user = userEvent.setup();
      const onResolve = vi.fn().mockResolvedValue(undefined);

      render(
        <GroupBulkResolveToolbar
          selectedIds={makeSelection(2)}
          onClear={vi.fn()}
          onSelectAll={vi.fn()}
          onResolve={onResolve}
          canTrash
        />,
      );

      await user.click(screen.getByRole('button', { name: /resolve.*delete/i }));
      await screen.findByRole('dialog');

      await user.click(screen.getByRole('button', { name: /move to trash/i }));

      await waitFor(() => {
        expect(onResolve).toHaveBeenCalledWith('trash');
      });
    });

    it('does not call onResolve when the dialog is cancelled', async () => {
      const user = userEvent.setup();
      const onResolve = vi.fn().mockResolvedValue(undefined);

      render(
        <GroupBulkResolveToolbar
          selectedIds={makeSelection(1)}
          onClear={vi.fn()}
          onSelectAll={vi.fn()}
          onResolve={onResolve}
          canTrash
        />,
      );

      await user.click(screen.getByRole('button', { name: /resolve.*delete/i }));
      await screen.findByRole('dialog');

      await user.click(screen.getByRole('button', { name: /^cancel$/i }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(onResolve).not.toHaveBeenCalled();
    });
  });

  describe('large-selection archive confirmation', () => {
    it('requires confirmation for an archive selection larger than 25', async () => {
      const user = userEvent.setup();
      const onResolve = vi.fn().mockResolvedValue(undefined);

      render(
        <GroupBulkResolveToolbar
          selectedIds={makeSelection(26)}
          onClear={vi.fn()}
          onSelectAll={vi.fn()}
          onResolve={onResolve}
          canTrash
        />,
      );

      await user.click(screen.getByRole('button', { name: /resolve.*archive/i }));

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
      });
      expect(onResolve).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: /^archive$/i }));

      await waitFor(() => {
        expect(onResolve).toHaveBeenCalledWith('archive');
      });
    });
  });

  describe('clear and select-all', () => {
    it('calls onClear when the cancel-selection icon is clicked', async () => {
      const user = userEvent.setup();
      const onClear = vi.fn();

      render(
        <GroupBulkResolveToolbar
          selectedIds={makeSelection(2)}
          onClear={onClear}
          onSelectAll={vi.fn()}
          onResolve={vi.fn().mockResolvedValue(undefined)}
          canTrash
        />,
      );

      await user.click(screen.getByRole('button', { name: /cancel selection/i }));

      expect(onClear).toHaveBeenCalledTimes(1);
    });

    it('calls onSelectAll when the select-all icon is clicked', async () => {
      const user = userEvent.setup();
      const onSelectAll = vi.fn();

      render(
        <GroupBulkResolveToolbar
          selectedIds={makeSelection(2)}
          onClear={vi.fn()}
          onSelectAll={onSelectAll}
          onResolve={vi.fn().mockResolvedValue(undefined)}
          canTrash
        />,
      );

      await user.click(screen.getByRole('button', { name: /^select all$/i }));

      expect(onSelectAll).toHaveBeenCalledTimes(1);
    });
  });
});
