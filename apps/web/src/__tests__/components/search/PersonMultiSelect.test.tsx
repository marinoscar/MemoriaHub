/**
 * Unit tests for PersonMultiSelect component.
 *
 * PersonMultiSelect is a controlled component that wraps a MUI Autocomplete
 * (multiple, freeSolo) and a ToggleButtonGroup for All/Any mode.
 *
 * We mock:
 *   - usePeople    — avoids real API calls; supplies a fixed list of PersonListItems
 *   - PersonAvatar — avoids rendering the avatar fetching logic (media API calls)
 *   - react-easy-crop — required by PersonAvatar's module-level import path
 *
 * Each test follows Arrange-Act-Assert and tests a single behaviour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any import that transitively loads them
// ---------------------------------------------------------------------------

vi.mock('react-easy-crop', () => ({ default: () => null }));

vi.mock('../../../hooks/usePeople', () => ({
  usePeople: vi.fn(),
}));

vi.mock('../../../components/people/PersonAvatar', () => ({
  PersonAvatar: () => <span data-testid="person-avatar" />,
}));

// ---------------------------------------------------------------------------
// Imports that depend on mocks
// ---------------------------------------------------------------------------

import { PersonMultiSelect } from '../../../components/search/PersonMultiSelect';
import { usePeople } from '../../../hooks/usePeople';
import type { PersonListItem } from '../../../services/face';

const mockUsePeople = vi.mocked(usePeople);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePerson(id: string, name: string): PersonListItem {
  return {
    id,
    name,
    isUnlabeled: false,
    faceCount: 1,
    coverFace: null,
    profileMediaItemId: null,
    profileCrop: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const OSCAR = makePerson('oscar-uuid', 'Oscar');
const PAMELA = makePerson('pamela-uuid', 'Pamela');
const UNLABELED = makePerson('unknown-uuid', null as unknown as string); // isUnlabeled person

const PEOPLE_LIST = [OSCAR, PAMELA];

function defaultUsePeopleReturn(items: PersonListItem[] = PEOPLE_LIST) {
  return {
    data: {
      items,
      meta: { page: 1, pageSize: 100, totalItems: items.length, totalPages: 1 },
    },
    loading: false,
    error: null,
    refresh: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    cluster: vi.fn(),
    assignFaces: vi.fn(),
    unassignFace: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyValue() {
  return { ids: [] as string[], mode: 'all' as const };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PersonMultiSelect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePeople.mockReturnValue(defaultUsePeopleReturn() as any);
  });

  // -------------------------------------------------------------------------
  describe('rendering', () => {
    it('renders the Autocomplete input with default label "People"', () => {
      const onChange = vi.fn();
      render(
        <PersonMultiSelect
          circleId="circle-1"
          value={emptyValue()}
          onChange={onChange}
        />,
      );

      expect(screen.getByLabelText(/people/i)).toBeInTheDocument();
    });

    it('renders a custom label when label prop is provided', () => {
      const onChange = vi.fn();
      render(
        <PersonMultiSelect
          circleId="circle-1"
          value={emptyValue()}
          onChange={onChange}
          label="Filter by person"
        />,
      );

      expect(screen.getByLabelText(/filter by person/i)).toBeInTheDocument();
    });

    it('renders the All and Any toggle buttons', () => {
      const onChange = vi.fn();
      render(
        <PersonMultiSelect
          circleId="circle-1"
          value={emptyValue()}
          onChange={onChange}
        />,
      );

      expect(screen.getByRole('button', { name: /^all$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^any$/i })).toBeInTheDocument();
    });

    it('calls usePeople with the circleId', () => {
      const onChange = vi.fn();
      render(
        <PersonMultiSelect
          circleId="circle-abc"
          value={emptyValue()}
          onChange={onChange}
        />,
      );

      expect(mockUsePeople).toHaveBeenCalledWith('circle-abc');
    });

    it('filters out unlabeled people (name == null) from options', async () => {
      mockUsePeople.mockReturnValue(
        defaultUsePeopleReturn([OSCAR, UNLABELED]) as any,
      );

      const onChange = vi.fn();
      render(
        <PersonMultiSelect
          circleId="circle-1"
          value={emptyValue()}
          onChange={onChange}
        />,
      );

      // Open the autocomplete
      const user = userEvent.setup();
      await user.click(screen.getByLabelText(/people/i));

      await waitFor(() => {
        // Oscar should appear as an option
        expect(screen.getByRole('option', { name: /oscar/i })).toBeInTheDocument();
      });

      // The unlabeled person (null name) should NOT appear
      const options = screen.getAllByRole('option');
      expect(options).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('controlled value — showing selected chips', () => {
    it('renders a chip for a pre-selected person (controlled value)', () => {
      const onChange = vi.fn();
      render(
        <PersonMultiSelect
          circleId="circle-1"
          value={{ ids: [OSCAR.id], mode: 'all' }}
          onChange={onChange}
        />,
      );

      // MUI Autocomplete renders selected items as chips with the option label
      expect(screen.getByText('Oscar')).toBeInTheDocument();
    });

    it('renders chips for multiple pre-selected people', () => {
      const onChange = vi.fn();
      render(
        <PersonMultiSelect
          circleId="circle-1"
          value={{ ids: [OSCAR.id, PAMELA.id], mode: 'all' }}
          onChange={onChange}
        />,
      );

      expect(screen.getByText('Oscar')).toBeInTheDocument();
      expect(screen.getByText('Pamela')).toBeInTheDocument();
    });

    it('reflects All mode as selected via aria-pressed on the All button', () => {
      const onChange = vi.fn();
      render(
        <PersonMultiSelect
          circleId="circle-1"
          value={{ ids: [], mode: 'all' }}
          onChange={onChange}
        />,
      );

      const allBtn = screen.getByRole('button', { name: /^all$/i });
      const anyBtn = screen.getByRole('button', { name: /^any$/i });

      // MUI ToggleButton uses aria-pressed to indicate selection
      expect(allBtn).toHaveAttribute('aria-pressed', 'true');
      expect(anyBtn).toHaveAttribute('aria-pressed', 'false');
    });

    it('reflects Any mode as selected via aria-pressed on the Any button', () => {
      const onChange = vi.fn();
      render(
        <PersonMultiSelect
          circleId="circle-1"
          value={{ ids: [], mode: 'any' }}
          onChange={onChange}
        />,
      );

      const allBtn = screen.getByRole('button', { name: /^all$/i });
      const anyBtn = screen.getByRole('button', { name: /^any$/i });

      expect(allBtn).toHaveAttribute('aria-pressed', 'false');
      expect(anyBtn).toHaveAttribute('aria-pressed', 'true');
    });
  });

  // -------------------------------------------------------------------------
  describe('onChange — selecting a person from the dropdown', () => {
    it('calls onChange with the selected person id when a person is chosen', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();

      render(
        <PersonMultiSelect
          circleId="circle-1"
          value={emptyValue()}
          onChange={onChange}
        />,
      );

      // Open the Autocomplete
      await user.click(screen.getByLabelText(/people/i));

      // Wait for Oscar option to appear and click it
      await waitFor(() => {
        expect(screen.getByRole('option', { name: /oscar/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('option', { name: /oscar/i }));

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          ids: [OSCAR.id],
          mode: 'all',
        }),
      );
    });

    it('preserves the current mode when selecting a person', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();

      render(
        <PersonMultiSelect
          circleId="circle-1"
          value={{ ids: [], mode: 'any' }}
          onChange={onChange}
        />,
      );

      await user.click(screen.getByLabelText(/people/i));

      await waitFor(() => {
        expect(screen.getByRole('option', { name: /oscar/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('option', { name: /oscar/i }));

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          ids: [OSCAR.id],
          mode: 'any', // preserved from the controlled value
        }),
      );
    });

    it('includes already-selected ids when adding another person', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();

      render(
        <PersonMultiSelect
          circleId="circle-1"
          value={{ ids: [OSCAR.id], mode: 'all' }}
          onChange={onChange}
        />,
      );

      await user.click(screen.getByLabelText(/people/i));

      await waitFor(() => {
        expect(screen.getByRole('option', { name: /pamela/i })).toBeInTheDocument();
      });

      await user.click(screen.getByRole('option', { name: /pamela/i }));

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          ids: expect.arrayContaining([OSCAR.id, PAMELA.id]),
          mode: 'all',
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('onChange — toggling All / Any mode', () => {
    it('calls onChange with mode:"any" when the Any button is clicked', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();

      render(
        <PersonMultiSelect
          circleId="circle-1"
          value={{ ids: [OSCAR.id], mode: 'all' }}
          onChange={onChange}
        />,
      );

      await user.click(screen.getByRole('button', { name: /^any$/i }));

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          ids: [OSCAR.id], // unchanged
          mode: 'any',
        }),
      );
    });

    it('calls onChange with mode:"all" when the All button is clicked from any mode', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();

      render(
        <PersonMultiSelect
          circleId="circle-1"
          value={{ ids: [OSCAR.id, PAMELA.id], mode: 'any' }}
          onChange={onChange}
        />,
      );

      await user.click(screen.getByRole('button', { name: /^all$/i }));

      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          ids: [OSCAR.id, PAMELA.id], // unchanged
          mode: 'all',
        }),
      );
    });

    it('does NOT call onChange when re-clicking the already-active toggle', async () => {
      const onChange = vi.fn();
      const user = userEvent.setup();

      render(
        <PersonMultiSelect
          circleId="circle-1"
          value={{ ids: [], mode: 'all' }}
          onChange={onChange}
        />,
      );

      // Click All when All is already active — MUI exclusive ToggleButtonGroup
      // fires null for the new value when you deselect the active button,
      // and the handler guards against null (if newMode !== null).
      await user.click(screen.getByRole('button', { name: /^all$/i }));

      // onChange should NOT be called because newMode is null
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('empty / loading states', () => {
    it('renders without error when usePeople returns null data', () => {
      mockUsePeople.mockReturnValue({
        ...defaultUsePeopleReturn([]),
        data: null,
      } as any);

      const onChange = vi.fn();
      expect(() =>
        render(
          <PersonMultiSelect
            circleId="circle-1"
            value={emptyValue()}
            onChange={onChange}
          />,
        ),
      ).not.toThrow();
    });

    it('renders without error when the people list is empty', () => {
      mockUsePeople.mockReturnValue(defaultUsePeopleReturn([]) as any);

      const onChange = vi.fn();
      render(
        <PersonMultiSelect
          circleId="circle-1"
          value={emptyValue()}
          onChange={onChange}
        />,
      );

      expect(screen.getByLabelText(/people/i)).toBeInTheDocument();
    });
  });
});
