/**
 * Unit tests for TagsPage — post-#259 (the shared-DataTable migration).
 *
 * Scope, per docs/specs/datatable.md §18.5: this file covers the page's own
 * column declarations (`./tagsTable.tsx`) and its mutations — NOT table
 * mechanics, which `runDataTableConformanceSuite` owns.
 *
 * The migration-specific things asserted here:
 *   - the generic DataTable CSV export is DISABLED while the bespoke
 *     `id,name` import/export round trip keeps its own two buttons (issue #259);
 *   - the inline row edit became a rename dialog and the `window.confirm`
 *     delete became the row action's own confirmation;
 *   - the enabled switch still lives in the cell (and therefore on the card).
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockAdminUser } from '../utils/test-utils';
import {
  installLayoutStubs,
  resetContainerWidth,
  setInitialContainerWidth,
} from '../../components/datatable/__tests__/testUtils/layoutStubs';

// ---------------------------------------------------------------------------
// Module mocks — declared before the imports they affect
// ---------------------------------------------------------------------------

vi.mock('../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

vi.mock('../../services/tagLabels', () => ({
  listTagLabels: vi.fn(),
  createTagLabel: vi.fn(),
  updateTagLabel: vi.fn(),
  deleteTagLabel: vi.fn(),
  exportTagLabels: vi.fn(),
  importTagLabels: vi.fn(),
}));

import TagsPage from '../../pages/Admin/TagsPage';
import { buildTagColumns } from '../../pages/Admin/tagsTable';
import { usePermissions } from '../../hooks/usePermissions';
import {
  listTagLabels,
  createTagLabel,
  updateTagLabel,
  deleteTagLabel,
  exportTagLabels,
} from '../../services/tagLabels';
import type { TagLabel } from '../../services/tagLabels';
import { api } from '../../services/api';

const mockUsePermissions = vi.mocked(usePermissions);
const mockList = vi.mocked(listTagLabels);
const mockCreate = vi.mocked(createTagLabel);
const mockUpdate = vi.mocked(updateTagLabel);
const mockDelete = vi.mocked(deleteTagLabel);
const mockExport = vi.mocked(exportTagLabels);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePermissions(isAdmin: boolean) {
  return {
    permissions: new Set<string>(),
    roles: new Set<string>(isAdmin ? ['admin'] : ['viewer']),
    hasPermission: vi.fn().mockReturnValue(isAdmin),
    hasAnyPermission: vi.fn().mockReturnValue(isAdmin),
    hasAllPermissions: vi.fn().mockReturnValue(isAdmin),
    hasRole: vi.fn().mockReturnValue(isAdmin),
    hasAnyRole: vi.fn().mockReturnValue(isAdmin),
    isAdmin,
  };
}

function makeLabel(overrides: Partial<TagLabel> = {}): TagLabel {
  return {
    id: 'label-1',
    name: 'beach',
    enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

function renderPage() {
  return render(<TagsPage />, { wrapperOptions: { user: mockAdminUser } });
}

async function openRowMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: `Row actions for ${name}` }));
}

// ---------------------------------------------------------------------------

describe('TagsPage', () => {
  beforeAll(() => {
    installLayoutStubs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetContainerWidth(1400);
    mockUsePermissions.mockReturnValue(makePermissions(true));
    mockList.mockResolvedValue([makeLabel({ id: 'l1', name: 'beach' })]);
    mockCreate.mockResolvedValue(makeLabel({ id: 'l2', name: 'sunset' }));
    mockUpdate.mockResolvedValue(makeLabel({ id: 'l1', name: 'seaside' }));
    mockDelete.mockResolvedValue(undefined as never);
    vi.spyOn(api, 'get').mockResolvedValue({} as never);
    vi.spyOn(api, 'patch').mockResolvedValue({} as never);
  });

  // =========================================================================
  // Authorization
  // =========================================================================

  it('redirects non-admin users — page content not shown', () => {
    mockUsePermissions.mockReturnValue(makePermissions(false));

    renderPage();

    expect(screen.queryByRole('heading', { name: /^tags$/i })).not.toBeInTheDocument();
  });

  it('renders the heading for admins', async () => {
    renderPage();

    expect(screen.getByRole('heading', { name: /^tags$/i })).toBeInTheDocument();
    await waitFor(() => expect(mockList).toHaveBeenCalled());
  });

  // =========================================================================
  // Column definitions
  // =========================================================================

  describe('Column definitions', () => {
    const columns = buildTagColumns({ onToggleEnabled: vi.fn() });

    it('leads with the (row-unique) name column', () => {
      expect(columns[0].id).toBe('name');
      expect(columns[0].priority).toBe('primary');
    });

    it('keeps the enabled switch as a rendered cell with a scalar behind it', () => {
      const enabled = columns.find((column) => column.id === 'enabled')!;
      expect(enabled.render).toBeTypeOf('function');
      expect(enabled.value!(makeLabel({ enabled: false }))).toBe('false');
    });
  });

  // =========================================================================
  // Vocabulary table
  // =========================================================================

  describe('Vocabulary table', () => {
    it('renders a row per label with its enable switch', async () => {
      mockList.mockResolvedValue([
        makeLabel({ id: 'l1', name: 'beach' }),
        makeLabel({ id: 'l2', name: 'sunset', enabled: false }),
      ]);

      renderPage();

      const grid = await screen.findByRole('grid', { name: /tag vocabulary/i });
      await waitFor(() => {
        expect(within(grid).getByText('beach')).toBeInTheDocument();
      });
      expect(within(grid).getByText('sunset')).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: 'Toggle beach' })).toBeChecked();
      expect(screen.getByRole('switch', { name: 'Toggle sunset' })).not.toBeChecked();
    });

    it('shows the empty state when the vocabulary is empty', async () => {
      mockList.mockResolvedValue([]);

      renderPage();

      await waitFor(() => {
        expect(screen.getByText(/no tag labels defined yet/i)).toBeInTheDocument();
      });
    });

    it('toggling the switch calls updateTagLabel with the new flag', async () => {
      const user = userEvent.setup();
      renderPage();

      const toggle = await screen.findByRole('switch', { name: 'Toggle beach' });
      await user.click(toggle);

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith('l1', { enabled: false });
      });
    });
  });

  // =========================================================================
  // Mutations through the row menu
  // =========================================================================

  describe('Row actions', () => {
    it('renames a label through the dialog', async () => {
      const user = userEvent.setup();
      renderPage();

      await openRowMenu(user, 'beach');
      await user.click(await screen.findByRole('menuitem', { name: /rename/i }));

      const dialog = await screen.findByRole('dialog');
      const field = within(dialog).getByLabelText(/label name/i);
      await user.clear(field);
      await user.type(field, 'seaside');
      await user.click(within(dialog).getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith('l1', { name: 'seaside' });
      });
    });

    it('deletes a label only after confirming', async () => {
      const user = userEvent.setup();
      renderPage();

      await openRowMenu(user, 'beach');
      await user.click(await screen.findByRole('menuitem', { name: /^delete$/i }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/delete tag label\?/i)).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
      expect(mockDelete).not.toHaveBeenCalled();

      await openRowMenu(user, 'beach');
      await user.click(await screen.findByRole('menuitem', { name: /^delete$/i }));
      const confirm = await screen.findByRole('dialog');
      await user.click(within(confirm).getByRole('button', { name: /^delete$/i }));

      await waitFor(() => {
        expect(mockDelete).toHaveBeenCalledWith('l1');
      });
    });
  });

  // =========================================================================
  // The bespoke CSV round trip — and the absence of the generic one
  // =========================================================================

  describe('CSV import / export', () => {
    it('keeps its own Export CSV and Import CSV buttons', async () => {
      renderPage();

      expect(await screen.findByRole('button', { name: /export csv/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /import csv/i })).toBeInTheDocument();
    });

    it('DISABLES the generic DataTable export so there is only one export button', async () => {
      renderPage();

      await screen.findByRole('grid', { name: /tag vocabulary/i });
      // The shared control renders as an "Export" button (desktop) or an
      // "Export CSV" menu item; neither may exist here.
      expect(screen.queryByRole('button', { name: /^export$/i })).not.toBeInTheDocument();
      expect(screen.queryByTestId('datatable-export-control')).not.toBeInTheDocument();
    });

    it('Export CSV downloads through the bespoke endpoint', async () => {
      const blob = new Blob(['id,name\n'], { type: 'text/csv' });
      mockExport.mockResolvedValue(blob);
      const createObjectURL = vi.fn().mockReturnValue('blob:mock');
      const revokeObjectURL = vi.fn();
      Object.defineProperty(global.URL, 'createObjectURL', {
        value: createObjectURL,
        writable: true,
      });
      Object.defineProperty(global.URL, 'revokeObjectURL', {
        value: revokeObjectURL,
        writable: true,
      });

      const user = userEvent.setup();
      renderPage();

      await user.click(await screen.findByRole('button', { name: /export csv/i }));

      await waitFor(() => {
        expect(mockExport).toHaveBeenCalled();
      });
      expect(createObjectURL).toHaveBeenCalledWith(blob);
    });
  });

  // =========================================================================
  // Add form (unchanged by the migration)
  // =========================================================================

  it('adds a label and appends it to the table', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.type(await screen.findByLabelText(/label name/i), 'sunset');
    await user.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith({ name: 'sunset' });
    });
    await waitFor(() => {
      expect(screen.getByText('sunset')).toBeInTheDocument();
    });
  });

  // =========================================================================
  // Phone
  // =========================================================================

  it('renders cards on a phone with the rename/delete actions still reachable', async () => {
    setInitialContainerWidth(360);
    const user = userEvent.setup();
    renderPage();

    const table = await screen.findByTestId('datatable');
    expect(table).toHaveAttribute('data-layout', 'mobile');

    await openRowMenu(user, 'beach');
    expect(await screen.findByRole('menuitem', { name: /rename/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /^delete$/i })).toBeInTheDocument();
  });
});
