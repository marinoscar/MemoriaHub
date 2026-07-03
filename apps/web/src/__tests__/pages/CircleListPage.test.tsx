import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';
import CircleListPage from '../../pages/Circles/CircleListPage';
import type { Circle } from '../../types/circles';

// ------------------------------------------------------------------
// Mock hooks
// ------------------------------------------------------------------

vi.mock('../../hooks/useCircles', () => ({
  useCircles: vi.fn(),
}));

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

// useCircleContext is exercised via the real CircleContext + test-utils'
// MockCircleProvider (driven by wrapperOptions.activeCircle), so it is not
// mocked here — this mirrors CircleDetailPage.test.tsx's approach when tighter
// control isn't needed.

import { useCircles } from '../../hooks/useCircles';
import { usePermissions } from '../../hooks/usePermissions';

const mockUseCircles = vi.mocked(useCircles);
const mockUsePermissions = vi.mocked(usePermissions);

// ------------------------------------------------------------------
// Fixtures
// ------------------------------------------------------------------

// Owned by the default test-utils user ('test-user-id'), not personal —
// eligible for both Edit and Delete when canManage is true.
const circleOwned: Circle = {
  id: 'circle-1',
  name: 'Owned Circle',
  description: 'Owned circle description',
  ownerId: 'test-user-id',
  isPersonal: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// Owned by someone else — with isAdmin: false, canManage is false.
const circleNotOwned: Circle = {
  id: 'circle-2',
  name: 'Other Circle',
  description: null,
  ownerId: 'other-user-id',
  isPersonal: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

// Owned by the default test-utils user AND personal — canManage true but
// Delete must be hidden (canManage && !circle.isPersonal).
const circlePersonalOwned: Circle = {
  id: 'circle-3',
  name: 'My Personal Library',
  description: null,
  ownerId: 'test-user-id',
  isPersonal: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function makeCirclesDefaults(overrides: Record<string, unknown> = {}) {
  return {
    circles: [circleOwned, circleNotOwned, circlePersonalOwned],
    loading: false,
    error: null,
    fetchCircles: vi.fn().mockResolvedValue(undefined),
    addCircle: vi.fn().mockResolvedValue(circleOwned),
    editCircle: vi.fn().mockResolvedValue(circleOwned),
    removeCircle: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function getCardFor(circleName: string): HTMLElement {
  const nameEl = screen.getByText(circleName);
  const card = nameEl.closest('.MuiCard-root') as HTMLElement | null;
  if (!card) throw new Error(`Could not find enclosing card for "${circleName}"`);
  return card;
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------

describe('CircleListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseCircles.mockReturnValue(makeCirclesDefaults());

    mockUsePermissions.mockReturnValue({
      permissions: new Set<string>(),
      roles: new Set<string>(),
      hasPermission: vi.fn(),
      hasAnyPermission: vi.fn(),
      hasAllPermissions: vi.fn(),
      hasRole: vi.fn(),
      hasAnyRole: vi.fn(),
      isAdmin: false,
    });
  });

  describe('Active chip', () => {
    it('renders an "Active" chip only for the circle matching activeCircleId', async () => {
      render(<CircleListPage />, { wrapperOptions: { activeCircle: circleOwned } });

      await waitFor(() => {
        expect(screen.getByText(circleOwned.name)).toBeInTheDocument();
      });

      const activeCard = getCardFor(circleOwned.name);
      expect(within(activeCard).getByText('Active')).toBeInTheDocument();

      const otherCard = getCardFor(circleNotOwned.name);
      expect(within(otherCard).queryByText('Active')).not.toBeInTheDocument();

      const personalCard = getCardFor(circlePersonalOwned.name);
      expect(within(personalCard).queryByText('Active')).not.toBeInTheDocument();
    });
  });

  describe('Edit / Delete visibility (canManage gating)', () => {
    it('shows both Edit and Delete for a circle the user owns', async () => {
      render(<CircleListPage />, { wrapperOptions: { activeCircle: circleOwned } });

      await waitFor(() => {
        expect(screen.getByText(circleOwned.name)).toBeInTheDocument();
      });

      const card = getCardFor(circleOwned.name);
      expect(within(card).getByRole('button', { name: /edit/i })).toBeInTheDocument();
      expect(within(card).getByRole('button', { name: /delete/i })).toBeInTheDocument();
    });

    it('hides both Edit and Delete for a circle the user does not own and is not admin', async () => {
      render(<CircleListPage />, { wrapperOptions: { activeCircle: circleOwned } });

      await waitFor(() => {
        expect(screen.getByText(circleNotOwned.name)).toBeInTheDocument();
      });

      const card = getCardFor(circleNotOwned.name);
      expect(within(card).queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
      expect(within(card).queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    });

    it('shows Edit but not Delete for a personal circle even when manageable', async () => {
      render(<CircleListPage />, { wrapperOptions: { activeCircle: circleOwned } });

      await waitFor(() => {
        expect(screen.getByText(circlePersonalOwned.name)).toBeInTheDocument();
      });

      const card = getCardFor(circlePersonalOwned.name);
      expect(within(card).getByRole('button', { name: /edit/i })).toBeInTheDocument();
      expect(within(card).queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    });
  });

  describe('Edit dialog', () => {
    it('opens an "Edit Circle" dialog pre-filled with the circle name and description', async () => {
      const user = userEvent.setup();

      render(<CircleListPage />, { wrapperOptions: { activeCircle: circleOwned } });

      await waitFor(() => {
        expect(screen.getByText(circleOwned.name)).toBeInTheDocument();
      });

      const card = getCardFor(circleOwned.name);
      await user.click(within(card).getByRole('button', { name: /edit/i }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Edit Circle')).toBeInTheDocument();
      expect(within(dialog).getByLabelText(/circle name/i)).toHaveValue(circleOwned.name);
      expect(within(dialog).getByLabelText(/description/i)).toHaveValue(
        circleOwned.description ?? '',
      );
    });
  });

  describe('Delete confirmation dialog', () => {
    it('opens a "Delete Circle" confirmation dialog mentioning the circle name, and confirming calls removeCircle with the circle id', async () => {
      const removeCircle = vi.fn().mockResolvedValue(undefined);
      mockUseCircles.mockReturnValue(makeCirclesDefaults({ removeCircle }));

      const user = userEvent.setup();

      render(<CircleListPage />, { wrapperOptions: { activeCircle: circleOwned } });

      await waitFor(() => {
        expect(screen.getByText(circleOwned.name)).toBeInTheDocument();
      });

      const card = getCardFor(circleOwned.name);
      await user.click(within(card).getByRole('button', { name: /delete/i }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Delete Circle')).toBeInTheDocument();
      expect(within(dialog).getByText(circleOwned.name)).toBeInTheDocument();

      // The dialog's own confirm button reads exactly "Delete" (distinct from
      // the card-level Delete button, which lives outside `dialog`).
      const confirmButton = within(dialog).getByRole('button', { name: /^delete$/i });
      await user.click(confirmButton);

      await waitFor(() => {
        expect(removeCircle).toHaveBeenCalledWith(circleOwned.id);
      });
    });
  });
});
