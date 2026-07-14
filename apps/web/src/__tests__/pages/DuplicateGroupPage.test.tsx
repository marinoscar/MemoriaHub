/**
 * Unit tests for DuplicateGroupPage.
 *
 * Covers:
 *  - Loading and error states
 *  - Rendering all group members and the metadata diff table
 *  - Keep-selection behavior: suggested best item is preselected in the keep
 *    Set; toggling a filmstrip member's checkbox adds/removes it from the
 *    keep set, reflected in the resolve buttons' enabled state and label.
 *  - Action gating: DuplicateGroupPage renders two standalone decision
 *    buttons — Archive (primary, always available) and Delete (error color,
 *    gated on media:delete) — instead of an Archive/Trash ToggleButtonGroup.
 *    Delete is hidden entirely when the caller lacks media:delete; Archive is
 *    always available regardless of permission.
 *  - Resolve confirm flow: clicking the Archive or Delete button opens a
 *    confirm Dialog; confirming calls resolve() with the correct
 *    (keepIds, action) args and shows a success Snackbar.
 *  - Dismiss flow: clicking dismiss opens a confirm Dialog; confirming calls
 *    dismiss().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

vi.mock('../../hooks/useDuplicates', () => ({
  useDuplicateGroupDetail: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ id: 'group-test-id' }),
  };
});

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import DuplicateGroupPage from '../../pages/Duplicates/DuplicateGroupPage';
import { usePermissions } from '../../hooks/usePermissions';
import { useCircle } from '../../hooks/useCircle';
import { useDuplicateGroupDetail } from '../../hooks/useDuplicates';
import type { DuplicateGroupDetail, DuplicateGroupMember } from '../../services/duplicates';

const mockUsePermissions = vi.mocked(usePermissions);
const mockUseCircle = vi.mocked(useCircle);
const mockUseDuplicateGroupDetail = vi.mocked(useDuplicateGroupDetail);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CIRCLE_ID = 'circle-1';

function makeCircle(id = CIRCLE_ID) {
  return {
    id,
    name: 'Test Circle',
    description: null,
    ownerId: 'user-1',
    isPersonal: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeCircleContext(overrides: Partial<ReturnType<typeof useCircle>> = {}): ReturnType<typeof useCircle> {
  return {
    activeCircle: makeCircle(),
    activeCircleId: CIRCLE_ID,
    activeCircleRole: 'collaborator',
    circles: [makeCircle()],
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ReturnType<typeof useCircle>;
}

function makePermissions(
  overrides: { isAdmin?: boolean; canTrash?: boolean } = {},
): ReturnType<typeof usePermissions> {
  const { isAdmin = false, canTrash = true } = overrides;
  return {
    permissions: new Set<string>(canTrash ? ['media:read', 'media:write', 'media:delete'] : ['media:read', 'media:write']),
    roles: new Set<string>(isAdmin ? ['admin'] : ['viewer']),
    hasPermission: vi.fn((perm: string) => (perm === 'media:delete' ? canTrash : true)),
    hasAnyPermission: vi.fn().mockReturnValue(true),
    hasAllPermissions: vi.fn().mockReturnValue(true),
    hasRole: vi.fn().mockReturnValue(isAdmin),
    hasAnyRole: vi.fn().mockReturnValue(isAdmin),
    isAdmin,
  } as unknown as ReturnType<typeof usePermissions>;
}

function makeMember(id: string, isSuggestedBest = false): DuplicateGroupMember {
  return {
    id,
    thumbnailUrl: `https://cdn.example.com/${id}-thumb.jpg`,
    previewUrl: `https://cdn.example.com/${id}-preview.jpg`,
    width: 4032,
    height: 3024,
    fileSize: 2_500_000,
    capturedAt: '2026-06-15T14:32:00.000Z',
    cameraMake: 'Apple',
    cameraModel: 'iPhone 14',
    hasGps: true,
    contentHash: 'abc123',
    sharpnessScore: isSuggestedBest ? 412.3 : 210.1,
    qualityScore: isSuggestedBest ? 0.92 : 0.5,
    similarityToBest: isSuggestedBest ? null : 0.97,
    isSuggestedBest,
  };
}

function makeGroupDetail(suggestedBestItemId = 'media-1'): DuplicateGroupDetail {
  return {
    id: 'group-test-id',
    circleId: CIRCLE_ID,
    status: 'pending',
    kind: 'exact_variant',
    mediaCount: 3,
    capturedAt: '2026-06-15T14:32:00.000Z',
    suggestedBestItemId,
    resolvedById: null,
    resolvedAt: null,
    members: [
      makeMember('media-1', suggestedBestItemId === 'media-1'),
      makeMember('media-2', suggestedBestItemId === 'media-2'),
      makeMember('media-3', suggestedBestItemId === 'media-3'),
    ],
  };
}

function makeDetailHook(
  overrides: Partial<ReturnType<typeof useDuplicateGroupDetail>> = {},
): ReturnType<typeof useDuplicateGroupDetail> {
  return {
    group: makeGroupDetail(),
    isLoading: false,
    error: null,
    fetchGroup: vi.fn().mockResolvedValue(undefined),
    resolve: vi.fn().mockResolvedValue({ removed: 2, kept: 1, action: 'archive', groupStatus: 'resolved' }),
    dismiss: vi.fn().mockResolvedValue({ groupStatus: 'dismissed', ungrouped: 3 }),
    resolving: false,
    dismissing: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DuplicateGroupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePermissions.mockReturnValue(makePermissions());
    mockUseCircle.mockReturnValue(makeCircleContext());
    mockUseDuplicateGroupDetail.mockReturnValue(makeDetailHook());
  });

  describe('loading and error states', () => {
    it('shows a loading spinner while fetching', () => {
      mockUseDuplicateGroupDetail.mockReturnValue(makeDetailHook({ group: null, isLoading: true }));

      render(<DuplicateGroupPage />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    it('shows an error message when the fetch fails', async () => {
      mockUseDuplicateGroupDetail.mockReturnValue(
        makeDetailHook({ group: null, error: 'Group not found', isLoading: false }),
      );

      render(<DuplicateGroupPage />);

      await waitFor(() => {
        expect(screen.getByText('Group not found')).toBeInTheDocument();
      });
    });
  });

  describe('rendering group members', () => {
    it('renders the "Duplicate Group" heading', async () => {
      render(<DuplicateGroupPage />);

      await waitFor(() => {
        expect(screen.getByText('Duplicate Group')).toBeInTheDocument();
      });
    });

    it('renders the metadata diff table with one column per member', async () => {
      render(<DuplicateGroupPage />);

      await waitFor(() => {
        expect(screen.getByText('Photo 1')).toBeInTheDocument();
        expect(screen.getByText('Photo 2')).toBeInTheDocument();
        expect(screen.getByText('Photo 3')).toBeInTheDocument();
      });
    });
  });

  describe('keep-selection behavior', () => {
    it('pre-selects the suggested best item in the keep set', async () => {
      // group has 3 members, media-1 is suggested best -> 1 pre-selected, 2 to remove
      render(<DuplicateGroupPage />);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /keep 1, archive 2 others/i }),
        ).toBeInTheDocument();
      });
    });

    it('the suggested best checkbox is checked by default', async () => {
      render(<DuplicateGroupPage />);

      await waitFor(() => {
        expect(screen.getByText('Duplicate Group')).toBeInTheDocument();
      });

      const checkboxes = screen.getAllByRole('checkbox');
      // 3 members; the first (media-1, suggested best) should be checked
      const checkedStates = checkboxes.map((cb) => (cb as HTMLInputElement).checked);
      expect(checkedStates.filter(Boolean)).toHaveLength(1);
    });

    it('toggling a non-selected member checkbox adds it to the keep set', async () => {
      const user = userEvent.setup();
      render(<DuplicateGroupPage />);

      await waitFor(() => expect(screen.getByText('Duplicate Group')).toBeInTheDocument());

      const checkboxes = screen.getAllByRole('checkbox');
      // Click the second checkbox (media-2, not pre-selected)
      await user.click(checkboxes[1]);

      await waitFor(() => {
        expect(
          screen.getByRole('button', { name: /keep 2, archive 1 other/i }),
        ).toBeInTheDocument();
      });
    });

    it('toggling the pre-selected suggested-best checkbox removes it from the keep set', async () => {
      const user = userEvent.setup();
      render(<DuplicateGroupPage />);

      await waitFor(() => expect(screen.getByText('Duplicate Group')).toBeInTheDocument());

      const checkboxes = screen.getAllByRole('checkbox');
      await user.click(checkboxes[0]); // media-1, pre-selected -> uncheck

      await waitFor(() => {
        expect(screen.getAllByRole('button', { name: /select photos to keep/i }).length).toBeGreaterThan(0);
      });
    });

    it('disables the resolve buttons when the keep set is empty', async () => {
      const user = userEvent.setup();
      render(<DuplicateGroupPage />);

      await waitFor(() => expect(screen.getByText('Duplicate Group')).toBeInTheDocument());

      const checkboxes = screen.getAllByRole('checkbox');
      await user.click(checkboxes[0]); // uncheck the only pre-selected item

      await waitFor(() => {
        const buttons = screen.getAllByRole('button', { name: /select photos to keep/i });
        expect(buttons.length).toBeGreaterThan(0);
        buttons.forEach((btn) => expect(btn).toBeDisabled());
      });
    });
  });

  // DuplicateGroupPage renders two standalone decision buttons — Archive
  // (primary, always available) and Delete (error color, gated on
  // media:delete) — instead of an Archive/Trash ToggleButtonGroup.
  describe('action gating — Archive/Delete buttons', () => {
    it('Delete button is absent when the user lacks media:delete', async () => {
      mockUsePermissions.mockReturnValue(makePermissions({ canTrash: false }));

      render(<DuplicateGroupPage />);

      await waitFor(() => expect(screen.getByText('Duplicate Group')).toBeInTheDocument());

      expect(screen.getByRole('button', { name: /keep 1, archive 2 others/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /keep 1, delete 2 others/i })).toBeNull();
    });

    it('Delete button is present and enabled when the user has media:delete', async () => {
      mockUsePermissions.mockReturnValue(makePermissions({ canTrash: true }));

      render(<DuplicateGroupPage />);

      await waitFor(() => expect(screen.getByText('Duplicate Group')).toBeInTheDocument());

      const deleteButton = screen.getByRole('button', { name: /keep 1, delete 2 others/i });
      expect(deleteButton).not.toBeDisabled();
    });

    it('Archive is available regardless of permission', async () => {
      mockUsePermissions.mockReturnValue(makePermissions({ canTrash: false }));

      render(<DuplicateGroupPage />);

      await waitFor(() => expect(screen.getByText('Duplicate Group')).toBeInTheDocument());

      const archiveButton = screen.getByRole('button', { name: /keep 1, archive 2 others/i });
      expect(archiveButton).not.toBeDisabled();
    });
  });

  describe('resolve confirm flow', () => {
    it('opens a confirm dialog when the resolve button is clicked', async () => {
      const user = userEvent.setup();
      render(<DuplicateGroupPage />);

      const resolveBtn = await screen.findByRole('button', { name: /keep 1, archive 2 others/i });
      await user.click(resolveBtn);

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(screen.getByText(/confirm archive/i)).toBeInTheDocument();
      });
    });

    it('calls resolve with (keepIds, action) after confirming', async () => {
      const user = userEvent.setup();
      const mockResolve = vi
        .fn()
        .mockResolvedValue({ removed: 2, kept: 1, action: 'archive', groupStatus: 'resolved' });
      mockUseDuplicateGroupDetail.mockReturnValue(makeDetailHook({ resolve: mockResolve }));

      render(<DuplicateGroupPage />);

      const resolveBtn = await screen.findByRole('button', { name: /keep 1, archive 2 others/i });
      await user.click(resolveBtn);

      const dialog = await screen.findByRole('dialog');
      const confirmBtn = within(dialog).getByRole('button', { name: /archive 2 photos/i });
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(mockResolve).toHaveBeenCalledWith(['media-1'], 'archive');
      });
    });

    it('sends action="trash" when the Delete button is clicked and confirmed', async () => {
      const user = userEvent.setup();
      const mockResolve = vi
        .fn()
        .mockResolvedValue({ removed: 2, kept: 1, action: 'trash', groupStatus: 'resolved' });
      mockUseDuplicateGroupDetail.mockReturnValue(makeDetailHook({ resolve: mockResolve }));

      render(<DuplicateGroupPage />);

      const deleteBtn = await screen.findByRole('button', { name: /keep 1, delete 2 others/i });
      await user.click(deleteBtn);

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/confirm trash/i)).toBeInTheDocument();
      const confirmBtn = within(dialog).getByRole('button', { name: /move to trash/i });
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(mockResolve).toHaveBeenCalledWith(['media-1'], 'trash');
      });
    });

    it('shows a success snackbar after a successful resolve', async () => {
      const user = userEvent.setup();
      mockUseDuplicateGroupDetail.mockReturnValue(
        makeDetailHook({
          resolve: vi.fn().mockResolvedValue({ removed: 2, kept: 1, action: 'archive', groupStatus: 'resolved' }),
        }),
      );

      render(<DuplicateGroupPage />);

      const resolveBtn = await screen.findByRole('button', { name: /keep 1, archive 2 others/i });
      await user.click(resolveBtn);

      const dialog = await screen.findByRole('dialog');
      const confirmBtn = within(dialog).getByRole('button', { name: /archive 2 photos/i });
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(screen.getByText(/kept 1 photo; 2 archived\./i)).toBeInTheDocument();
      });
    });

    it('shows an error alert when resolve rejects', async () => {
      const user = userEvent.setup();
      mockUseDuplicateGroupDetail.mockReturnValue(
        makeDetailHook({ resolve: vi.fn().mockRejectedValue(new Error('Resolve failed')) }),
      );

      render(<DuplicateGroupPage />);

      const resolveBtn = await screen.findByRole('button', { name: /keep 1, archive 2 others/i });
      await user.click(resolveBtn);

      const dialog = await screen.findByRole('dialog');
      const confirmBtn = within(dialog).getByRole('button', { name: /archive 2 photos/i });
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(screen.getByText('Resolve failed')).toBeInTheDocument();
      });
    });
  });

  describe('dismiss flow', () => {
    it('opens a confirm dialog when the dismiss button is clicked', async () => {
      const user = userEvent.setup();
      render(<DuplicateGroupPage />);

      const dismissBtn = await screen.findByRole('button', { name: /not duplicates.*dismiss/i });
      await user.click(dismissBtn);

      await waitFor(() => {
        expect(screen.getByText(/dismiss duplicate group/i)).toBeInTheDocument();
      });
    });

    it('calls dismiss() after confirming', async () => {
      const user = userEvent.setup();
      const mockDismiss = vi.fn().mockResolvedValue({ groupStatus: 'dismissed', ungrouped: 3 });
      mockUseDuplicateGroupDetail.mockReturnValue(makeDetailHook({ dismiss: mockDismiss }));

      render(<DuplicateGroupPage />);

      const dismissBtn = await screen.findByRole('button', { name: /not duplicates.*dismiss/i });
      await user.click(dismissBtn);

      const dialog = await screen.findByRole('dialog');
      const confirmBtn = within(dialog).getByRole('button', { name: /^dismiss$/i });
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(mockDismiss).toHaveBeenCalledTimes(1);
      });
    });

    it('shows a success snackbar after a successful dismiss', async () => {
      const user = userEvent.setup();
      mockUseDuplicateGroupDetail.mockReturnValue(
        makeDetailHook({ dismiss: vi.fn().mockResolvedValue({ groupStatus: 'dismissed', ungrouped: 3 }) }),
      );

      render(<DuplicateGroupPage />);

      const dismissBtn = await screen.findByRole('button', { name: /not duplicates.*dismiss/i });
      await user.click(dismissBtn);

      const dialog = await screen.findByRole('dialog');
      const confirmBtn = within(dialog).getByRole('button', { name: /^dismiss$/i });
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(screen.getByText(/duplicate group dismissed/i)).toBeInTheDocument();
      });
    });

    it('shows an error alert when dismiss rejects', async () => {
      const user = userEvent.setup();
      mockUseDuplicateGroupDetail.mockReturnValue(
        makeDetailHook({ dismiss: vi.fn().mockRejectedValue(new Error('Dismiss failed')) }),
      );

      render(<DuplicateGroupPage />);

      const dismissBtn = await screen.findByRole('button', { name: /not duplicates.*dismiss/i });
      await user.click(dismissBtn);

      const dialog = await screen.findByRole('dialog');
      const confirmBtn = within(dialog).getByRole('button', { name: /^dismiss$/i });
      await user.click(confirmBtn);

      await waitFor(() => {
        expect(screen.getByText('Dismiss failed')).toBeInTheDocument();
      });
    });
  });
});
