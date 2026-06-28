/**
 * Tests for apps/web/src/components/share/ShareDialog.tsx
 *
 * Covers:
 *  Initial state (no active share):
 *   - renders "Share publicly" dialog title
 *   - renders "Make public" button
 *   - clicking "Make public" calls createShare with correct target and expiresAt
 *   - after createShare resolves, the public URL is shown
 *   - after createShare resolves, the copy button renders
 *   - clicking the copy button calls navigator.clipboard.writeText with the URL
 *   - shows error alert when createShare rejects
 *   - expiration option "7d" passes a future expiresAt to createShare
 *   - expiration option "never" passes null expiresAt
 *
 *  Shared state (active share):
 *   - "Update expiration" button calls updateShare with the share id
 *   - clicking "Revoke (make private)" calls revokeShare with the share id
 *   - after revoke succeeds, the dialog returns to the initial state
 *   - shows error alert when revokeShare rejects
 *
 *  Album target:
 *   - createShare is called with albumId when target.type === 'album'
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';

// ---------------------------------------------------------------------------
// Module-level mocks — declared before imports they affect
// ---------------------------------------------------------------------------

vi.mock('../../../services/shareService', () => ({
  createShare: vi.fn(),
  updateShare: vi.fn(),
  revokeShare: vi.fn(),
  listShares: vi.fn(),
  bulkShares: vi.fn(),
}));

import { createShare, updateShare, revokeShare } from '../../../services/shareService';
import { ShareDialog } from '../../../components/share/ShareDialog';
import type { MediaShare } from '../../../types/sharing';

const mockCreateShare = vi.mocked(createShare);
const mockUpdateShare = vi.mocked(updateShare);
const mockRevokeShare = vi.mocked(revokeShare);

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeShare(overrides: Partial<MediaShare> = {}): MediaShare {
  return {
    id: 'share-id-1',
    token: 'tok123',
    publicUrl: 'https://app.example.com/s/tok123',
    targetType: 'media_item',
    status: 'active',
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  target: { type: 'media_item' as const, id: 'item-id-1' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ShareDialog', () => {
  // Install a clipboard mock at module scope so it is available before the component runs.
  // jsdom does not implement navigator.clipboard; we set it up here so the component
  // finds it during the writeText call.
  const writeTextMock = vi.fn().mockResolvedValue(undefined);

  beforeAll(() => {
    Object.defineProperty(window, 'navigator', {
      value: {
        ...window.navigator,
        clipboard: { writeText: writeTextMock },
      },
      writable: true,
      configurable: true,
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    writeTextMock.mockResolvedValue(undefined);
    // Default: createShare resolves with a share
    mockCreateShare.mockResolvedValue(makeShare());
    mockUpdateShare.mockResolvedValue(makeShare());
    mockRevokeShare.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------------

  describe('Initial state', () => {
    it('renders "Share publicly" dialog title', () => {
      render(<ShareDialog {...defaultProps} />);
      expect(screen.getByText('Share publicly')).toBeInTheDocument();
    });

    it('renders "Make public" button', () => {
      render(<ShareDialog {...defaultProps} />);
      expect(screen.getByRole('button', { name: /make public/i })).toBeInTheDocument();
    });

    it('renders expiration selector', () => {
      render(<ShareDialog {...defaultProps} />);
      expect(screen.getByLabelText(/expires/i)).toBeInTheDocument();
    });

    it('calls createShare with correct mediaItemId and null expiresAt when "never" is selected', async () => {
      const user = userEvent.setup();
      render(<ShareDialog {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /make public/i }));

      await waitFor(() => {
        expect(mockCreateShare).toHaveBeenCalledWith(
          expect.objectContaining({
            targetType: 'media_item',
            mediaItemId: 'item-id-1',
            expiresAt: null,
          }),
        );
      });
    });

    it('after createShare resolves, shows the public URL', async () => {
      const share = makeShare({ publicUrl: 'https://app.example.com/s/tok123' });
      mockCreateShare.mockResolvedValue(share);

      const user = userEvent.setup();
      render(<ShareDialog {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /make public/i }));

      await waitFor(() => {
        expect(screen.getByDisplayValue('https://app.example.com/s/tok123')).toBeInTheDocument();
      });
    });

    it('after createShare resolves, renders the copy link button', async () => {
      mockCreateShare.mockResolvedValue(makeShare());

      const user = userEvent.setup();
      render(<ShareDialog {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /make public/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /copy link/i })).toBeInTheDocument();
      });
    });

    it('shows error alert when createShare rejects', async () => {
      mockCreateShare.mockRejectedValue(new Error('Failed to create share link'));

      const user = userEvent.setup();
      render(<ShareDialog {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /make public/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.getByText(/failed to create share link/i)).toBeInTheDocument();
      });
    });

    it('passes a future expiresAt when "7d" option is selected', async () => {
      const user = userEvent.setup();
      render(<ShareDialog {...defaultProps} />);

      // Open the Select dropdown and pick "7 days"
      const expiresSelect = screen.getByLabelText(/expires/i);
      fireEvent.mouseDown(expiresSelect);
      await waitFor(() => screen.getByRole('option', { name: /7 days/i }));
      await user.click(screen.getByRole('option', { name: /7 days/i }));

      await user.click(screen.getByRole('button', { name: /make public/i }));

      await waitFor(() => {
        expect(mockCreateShare).toHaveBeenCalledOnce();
        const call = mockCreateShare.mock.calls[0][0];
        expect(call.expiresAt).toBeTruthy();
        const expiresAt = new Date(call.expiresAt as string);
        const now = new Date();
        // Should be ~7 days in the future (at least 6 days from now)
        expect(expiresAt.getTime()).toBeGreaterThan(now.getTime() + 6 * 24 * 60 * 60 * 1000);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Copy URL
  // -------------------------------------------------------------------------

  describe('Copy URL', () => {
    it('clicking copy button calls navigator.clipboard.writeText with the public URL', async () => {
      const share = makeShare({ publicUrl: 'https://app.example.com/s/tok123' });
      mockCreateShare.mockResolvedValue(share);

      // Spy on the clipboard that was set up in beforeAll; must be done inside
      // the test so the spy is fresh (clearAllMocks would have cleared counts).
      const spy = vi.spyOn(window.navigator.clipboard, 'writeText').mockResolvedValue(undefined);

      const user = userEvent.setup();
      render(<ShareDialog {...defaultProps} />);

      // First make the share active
      await user.click(screen.getByRole('button', { name: /make public/i }));
      await waitFor(() => screen.getByRole('button', { name: /copy link/i }));

      await user.click(screen.getByRole('button', { name: /copy link/i }));

      await waitFor(() => {
        expect(spy).toHaveBeenCalledWith('https://app.example.com/s/tok123');
      });

      spy.mockRestore();
    });

    it('clicking copy button shows "Copied!" snackbar feedback when clipboard succeeds', async () => {
      const share = makeShare({ publicUrl: 'https://app.example.com/s/tok123' });
      mockCreateShare.mockResolvedValue(share);

      const user = userEvent.setup();
      render(<ShareDialog {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /make public/i }));
      await waitFor(() => screen.getByRole('button', { name: /copy link/i }));

      await user.click(screen.getByRole('button', { name: /copy link/i }));

      await waitFor(() => {
        expect(screen.getByText('Copied!')).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Shared state — update expiration
  // -------------------------------------------------------------------------

  describe('Update expiration', () => {
    async function renderWithActiveShare() {
      const share = makeShare();
      mockCreateShare.mockResolvedValue(share);

      const user = userEvent.setup();
      render(<ShareDialog {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /make public/i }));
      await waitFor(() => screen.getByRole('button', { name: /update expiration/i }));

      return { user, share };
    }

    it('renders "Update expiration" button after share is created', async () => {
      await renderWithActiveShare();
      expect(screen.getByRole('button', { name: /update expiration/i })).toBeInTheDocument();
    });

    it('calls updateShare with the share id when "Update expiration" is clicked', async () => {
      const share = makeShare({ id: 'share-id-1' });
      mockCreateShare.mockResolvedValue(share);
      mockUpdateShare.mockResolvedValue(share);

      const { user } = await renderWithActiveShare();

      await user.click(screen.getByRole('button', { name: /update expiration/i }));

      await waitFor(() => {
        expect(mockUpdateShare).toHaveBeenCalledWith(
          'share-id-1',
          expect.objectContaining({ expiresAt: null }),
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // Revoke
  // -------------------------------------------------------------------------

  describe('Revoke', () => {
    async function renderWithActiveShare() {
      const share = makeShare({ id: 'share-id-1' });
      mockCreateShare.mockResolvedValue(share);

      const user = userEvent.setup();
      render(<ShareDialog {...defaultProps} />);

      await user.click(screen.getByRole('button', { name: /make public/i }));
      await waitFor(() => screen.getByRole('button', { name: /revoke/i }));

      return { user, share };
    }

    it('renders "Revoke" button after share is created', async () => {
      await renderWithActiveShare();
      expect(screen.getByRole('button', { name: /revoke/i })).toBeInTheDocument();
    });

    it('calls revokeShare with the share id when revoke button is clicked', async () => {
      const { user } = await renderWithActiveShare();

      await user.click(screen.getByRole('button', { name: /revoke/i }));

      await waitFor(() => {
        expect(mockRevokeShare).toHaveBeenCalledWith('share-id-1');
      });
    });

    it('returns to initial state after revoke succeeds (shows "Make public" again)', async () => {
      mockRevokeShare.mockResolvedValue(undefined);
      const { user } = await renderWithActiveShare();

      await user.click(screen.getByRole('button', { name: /revoke/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /make public/i })).toBeInTheDocument();
      });
    });

    it('shows error alert when revokeShare rejects', async () => {
      mockRevokeShare.mockRejectedValue(new Error('Failed to revoke share link'));
      const { user } = await renderWithActiveShare();

      await user.click(screen.getByRole('button', { name: /revoke/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Album target
  // -------------------------------------------------------------------------

  describe('Album target', () => {
    it('calls createShare with albumId when target.type is "album"', async () => {
      const albumProps = {
        ...defaultProps,
        target: { type: 'album' as const, id: 'album-id-1' },
      };
      mockCreateShare.mockResolvedValue(makeShare({ targetType: 'album' }));

      const user = userEvent.setup();
      render(<ShareDialog {...albumProps} />);

      await user.click(screen.getByRole('button', { name: /make public/i }));

      await waitFor(() => {
        expect(mockCreateShare).toHaveBeenCalledWith(
          expect.objectContaining({
            targetType: 'album',
            albumId: 'album-id-1',
          }),
        );
      });
    });

    it('does not pass mediaItemId when target.type is "album"', async () => {
      const albumProps = {
        ...defaultProps,
        target: { type: 'album' as const, id: 'album-id-2' },
      };
      mockCreateShare.mockResolvedValue(makeShare({ targetType: 'album' }));

      const user = userEvent.setup();
      render(<ShareDialog {...albumProps} />);

      await user.click(screen.getByRole('button', { name: /make public/i }));

      await waitFor(() => {
        const call = mockCreateShare.mock.calls[0][0];
        expect(call).not.toHaveProperty('mediaItemId');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Close / cancel
  // -------------------------------------------------------------------------

  describe('Cancel', () => {
    it('calls onClose when Cancel button is clicked', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(<ShareDialog {...defaultProps} onClose={onClose} />);

      await user.click(screen.getByRole('button', { name: /cancel/i }));

      expect(onClose).toHaveBeenCalledOnce();
    });
  });
});
