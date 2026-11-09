/**
 * Tests for OwnerScopeChip (issue #389, epic #388, spec §3.3/§4.1).
 *
 * The active-circle switcher promoted into the top bar. `useCircle` is
 * mocked directly (the same pattern AppBar.test.tsx and the former
 * UserMenu.test.tsx circle-section tests use) so a real multi-circle menu can
 * be exercised deterministically.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { OwnerScopeChip } from '../../../components/navigation/OwnerScopeChip';
import type { Circle } from '../../../types/circles';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../../hooks/useCircle', () => ({
  useCircle: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

import { useCircle } from '../../../hooks/useCircle';

const mockUseCircle = vi.mocked(useCircle);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockCircle1: Circle = {
  id: 'circle-1',
  name: 'Personal Library',
  description: null,
  ownerId: 'test-user-id',
  isPersonal: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockCircle2: Circle = {
  id: 'circle-2',
  name: 'Family Circle',
  description: 'Our family',
  ownerId: 'test-user-id',
  isPersonal: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const LONG_NAME_CIRCLE: Circle = {
  ...mockCircle1,
  id: 'circle-long',
  name: 'The Extremely Long Extended Family Photo Archive Circle Name',
};

function makeCircleDefaults(overrides: Record<string, unknown> = {}) {
  return {
    circles: [mockCircle1, mockCircle2],
    activeCircle: mockCircle1,
    activeCircleId: mockCircle1.id,
    activeCircleRole: 'circle_admin' as const,
    loading: false,
    setActiveCircle: vi.fn().mockResolvedValue(undefined),
    refreshCircles: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('OwnerScopeChip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseCircle.mockReturnValue(makeCircleDefaults());
  });

  // =========================================================================
  // No active circle -> renders nothing
  // =========================================================================

  describe('no active circle', () => {
    it('renders null when there is no active circle', () => {
      mockUseCircle.mockReturnValue(makeCircleDefaults({ activeCircle: null, activeCircleId: null }));

      const { container } = render(<OwnerScopeChip />);

      expect(container).toBeEmptyDOMElement();
    });
  });

  // =========================================================================
  // Rendering
  // =========================================================================

  describe('rendering', () => {
    it('renders the active circle name as its visible label', () => {
      render(<OwnerScopeChip />);

      expect(screen.getByText('Personal Library')).toBeInTheDocument();
    });

    it('renders as a real <button>, not a div-with-role', () => {
      render(<OwnerScopeChip />);

      const chip = screen.getByRole('button', { name: /active library/i });
      expect(chip.tagName).toBe('BUTTON');
    });

    it('sets an accessible name that carries the full circle name', () => {
      render(<OwnerScopeChip />);

      expect(
        screen.getByRole('button', { name: 'Active library: Personal Library. Change library.' }),
      ).toBeInTheDocument();
    });

    it('re-renders the accessible name when the active circle changes', () => {
      const { rerender } = render(<OwnerScopeChip />);
      expect(screen.getByRole('button', { name: /Active library: Personal Library/ })).toBeInTheDocument();

      mockUseCircle.mockReturnValue(makeCircleDefaults({ activeCircle: mockCircle2, activeCircleId: 'circle-2' }));
      rerender(<OwnerScopeChip />);

      expect(screen.getByRole('button', { name: /Active library: Family Circle/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Active library: Personal Library/ })).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Menu open/close + aria-expanded
  // =========================================================================

  describe('menu interaction', () => {
    it('is closed by default (aria-expanded absent)', () => {
      render(<OwnerScopeChip />);

      const chip = screen.getByRole('button', { name: /active library/i });
      expect(chip).not.toHaveAttribute('aria-expanded');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('opens the menu on click and flips aria-expanded to true', async () => {
      const user = userEvent.setup();
      render(<OwnerScopeChip />);

      const chip = screen.getByRole('button', { name: /active library/i });
      await user.click(chip);

      await waitFor(() => {
        expect(chip).toHaveAttribute('aria-expanded', 'true');
      });
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('lists every member circle plus a "Manage groups" item', async () => {
      const user = userEvent.setup();
      render(<OwnerScopeChip />);

      await user.click(screen.getByRole('button', { name: /active library/i }));

      await waitFor(() => {
        expect(screen.getByRole('menuitem', { name: 'Personal Library' })).toBeInTheDocument();
      });
      expect(screen.getByRole('menuitem', { name: 'Family Circle' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /manage groups/i })).toBeInTheDocument();
    });

    it('closes the menu when a circle is picked', async () => {
      const user = userEvent.setup();
      render(<OwnerScopeChip />);

      await user.click(screen.getByRole('button', { name: /active library/i }));
      const familyItem = await screen.findByRole('menuitem', { name: 'Family Circle' });
      await user.click(familyItem);

      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Selecting a circle
  // =========================================================================

  describe('selecting a circle', () => {
    it('calls setActiveCircle with the clicked circle id', async () => {
      const setActiveCircle = vi.fn().mockResolvedValue(undefined);
      mockUseCircle.mockReturnValue(makeCircleDefaults({ setActiveCircle }));

      const user = userEvent.setup();
      render(<OwnerScopeChip />);

      await user.click(screen.getByRole('button', { name: /active library/i }));
      const familyItem = await screen.findByRole('menuitem', { name: 'Family Circle' });
      await user.click(familyItem);

      await waitFor(() => {
        expect(setActiveCircle).toHaveBeenCalledWith('circle-2');
      });
    });

    it('marks the currently active circle as selected in the menu', async () => {
      const user = userEvent.setup();
      render(<OwnerScopeChip />);

      await user.click(screen.getByRole('button', { name: /active library/i }));

      const activeItem = await screen.findByRole('menuitem', { name: 'Personal Library' });
      expect(activeItem.classList.contains('Mui-selected')).toBe(true);

      const otherItem = screen.getByRole('menuitem', { name: 'Family Circle' });
      expect(otherItem.classList.contains('Mui-selected')).toBe(false);
    });
  });

  // =========================================================================
  // Manage groups
  // =========================================================================

  describe('Manage groups', () => {
    it('navigates to /settings/groups when clicked', async () => {
      const user = userEvent.setup();
      render(<OwnerScopeChip />);

      await user.click(screen.getByRole('button', { name: /active library/i }));
      const manageItem = await screen.findByRole('menuitem', { name: /manage groups/i });
      await user.click(manageItem);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith('/settings/groups');
      });
    });

    it('closes the menu after navigating', async () => {
      const user = userEvent.setup();
      render(<OwnerScopeChip />);

      await user.click(screen.getByRole('button', { name: /active library/i }));
      const manageItem = await screen.findByRole('menuitem', { name: /manage groups/i });
      await user.click(manageItem);

      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    });

    it('does NOT call setActiveCircle when only "Manage groups" is clicked', async () => {
      const setActiveCircle = vi.fn().mockResolvedValue(undefined);
      mockUseCircle.mockReturnValue(makeCircleDefaults({ setActiveCircle }));

      const user = userEvent.setup();
      render(<OwnerScopeChip />);

      await user.click(screen.getByRole('button', { name: /active library/i }));
      const manageItem = await screen.findByRole('menuitem', { name: /manage groups/i });
      await user.click(manageItem);

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/settings/groups'));
      expect(setActiveCircle).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Long-name truncation (spec §3.3's "never widen the toolbar" rule)
  // =========================================================================

  describe('long circle name truncation', () => {
    it('caps the label with a maxWidth and keeps ellipsis truncation styling regardless of name length', () => {
      mockUseCircle.mockReturnValue(
        makeCircleDefaults({ activeCircle: LONG_NAME_CIRCLE, activeCircleId: LONG_NAME_CIRCLE.id }),
      );

      render(<OwnerScopeChip />);

      const chip = screen.getByRole('button', { name: new RegExp(LONG_NAME_CIRCLE.name) });
      // The button itself is capped so a long name cannot widen the toolbar.
      expect(chip).toHaveStyle({ minWidth: '0px' });

      // The inner label span is the element that actually clips the text.
      const label = screen.getByText(LONG_NAME_CIRCLE.name);
      expect(label).toHaveStyle({
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      });
    });

    it('still renders the FULL name in the accessible name even though it is visually truncated', () => {
      mockUseCircle.mockReturnValue(
        makeCircleDefaults({ activeCircle: LONG_NAME_CIRCLE, activeCircleId: LONG_NAME_CIRCLE.id }),
      );

      render(<OwnerScopeChip />);

      expect(
        screen.getByRole('button', {
          name: `Active library: ${LONG_NAME_CIRCLE.name}. Change library.`,
        }),
      ).toBeInTheDocument();
    });
  });
});
