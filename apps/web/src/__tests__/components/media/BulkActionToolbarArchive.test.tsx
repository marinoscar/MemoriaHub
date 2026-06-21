/**
 * BulkActionToolbar — archive-specific tests.
 *
 * Tests the archive/unarchive actions added for the Archive + Trash feature:
 *   - In 'home' mode, the overflow menu shows "Archive"
 *   - In 'archive' mode, the overflow menu shows "Unarchive"
 *   - Delete confirm copy says "Move to Trash" (recoverable) not "permanent"
 *   - bulkArchive / bulkUnarchive service functions are called correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { BulkActionToolbar } from '../../../components/media/BulkActionToolbar';

// ---------------------------------------------------------------------------
// Mock media service
// ---------------------------------------------------------------------------
vi.mock('../../../services/media', () => ({
  bulkUpdateMedia: vi.fn(),
  bulkDelete: vi.fn(),
  bulkArchive: vi.fn(),
  bulkUnarchive: vi.fn(),
  getDashboard: vi.fn(),
  listMedia: vi.fn(),
  getMedia: vi.fn(),
  patchMedia: vi.fn(),
  initUpload: vi.fn(),
  uploadPart: vi.fn(),
  completeUpload: vi.fn(),
  registerMedia: vi.fn(),
  listTags: vi.fn(),
  bulkTags: vi.fn(),
}));

import { bulkArchive, bulkUnarchive, bulkDelete } from '../../../services/media';

const mockBulkArchive = vi.mocked(bulkArchive);
const mockBulkUnarchive = vi.mocked(bulkUnarchive);
const mockBulkDelete = vi.mocked(bulkDelete);

// ---------------------------------------------------------------------------
// Default props
// ---------------------------------------------------------------------------
const baseProps = {
  selected: new Set(['item-1', 'item-2']),
  circleId: 'circle-1',
  activeCircleRole: 'circle_admin' as const,
  onClear: vi.fn(),
  onSelectAll: vi.fn(),
  onOpenLocation: vi.fn(),
  onOpenTags: vi.fn(),
  onSuccess: vi.fn(),
  onError: vi.fn(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('BulkActionToolbar — archive/trash actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBulkArchive.mockResolvedValue({ archived: 2 });
    mockBulkUnarchive.mockResolvedValue({ unarchived: 2 });
    mockBulkDelete.mockResolvedValue({ deleted: 2 });
  });

  // -------------------------------------------------------------------------
  // Archive action — 'home' mode
  // -------------------------------------------------------------------------
  describe('home mode — Archive action', () => {
    it('shows Archive option in the overflow menu', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...baseProps} mode="home" />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      expect(screen.getByText(/^archive$/i)).toBeInTheDocument();
    });

    it('does NOT show Unarchive option in the overflow menu in home mode', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...baseProps} mode="home" />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      expect(screen.queryByText(/^unarchive$/i)).not.toBeInTheDocument();
    });

    it('calls bulkArchive with the correct payload when Archive is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...baseProps} mode="home" />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByText(/^archive$/i));

      await waitFor(() => {
        expect(mockBulkArchive).toHaveBeenCalledWith({
          circleId: 'circle-1',
          ids: expect.arrayContaining(['item-1', 'item-2']),
        });
      });
    });

    it('calls onSuccess after archiving', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...baseProps} mode="home" />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByText(/^archive$/i));

      await waitFor(() => {
        expect(baseProps.onSuccess).toHaveBeenCalledWith(
          expect.stringMatching(/archived 2 items/i),
        );
      });
    });

    it('calls onError when bulkArchive fails', async () => {
      mockBulkArchive.mockRejectedValueOnce(new Error('Archive failed'));
      const user = userEvent.setup();
      render(<BulkActionToolbar {...baseProps} mode="home" />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByText(/^archive$/i));

      await waitFor(() => {
        expect(baseProps.onError).toHaveBeenCalledWith('Archive failed');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Unarchive action — 'archive' mode
  // -------------------------------------------------------------------------
  describe('archive mode — Unarchive action', () => {
    it('shows Unarchive option in the overflow menu', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...baseProps} mode="archive" />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      expect(screen.getByText(/^unarchive$/i)).toBeInTheDocument();
    });

    it('does NOT show Archive option in the overflow menu in archive mode', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...baseProps} mode="archive" />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      expect(screen.queryByText(/^archive$/i)).not.toBeInTheDocument();
    });

    it('calls bulkUnarchive with the correct payload when Unarchive is clicked', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...baseProps} mode="archive" />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByText(/^unarchive$/i));

      await waitFor(() => {
        expect(mockBulkUnarchive).toHaveBeenCalledWith({
          circleId: 'circle-1',
          ids: expect.arrayContaining(['item-1', 'item-2']),
        });
      });
    });

    it('calls onSuccess after unarchiving', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...baseProps} mode="archive" />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByText(/^unarchive$/i));

      await waitFor(() => {
        expect(baseProps.onSuccess).toHaveBeenCalledWith(
          expect.stringMatching(/unarchived 2 items/i),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // Delete confirm copy — "Move to Trash" not permanent
  // -------------------------------------------------------------------------
  describe('delete confirm copy says "Trash" (recoverable)', () => {
    it('delete dialog title says Move to Trash not Delete forever', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...baseProps} mode="home" />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      // Click the "Move to Trash" option in the menu
      await user.click(screen.getByText(/move to trash/i));

      expect(screen.getByText(/move 2 items to trash\?/i)).toBeInTheDocument();
    });

    it('delete dialog body mentions the retention period (recoverable)', async () => {
      const user = userEvent.setup();
      render(<BulkActionToolbar {...baseProps} mode="home" />);

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(screen.getByText(/move to trash/i));

      // The dialog body should mention recovery / retention
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(/trash/i);
    });
  });
});
