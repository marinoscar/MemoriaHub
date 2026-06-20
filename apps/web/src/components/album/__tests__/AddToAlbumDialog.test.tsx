/**
 * Component tests — AddToAlbumDialog
 *
 * Mocking strategy:
 *   - `services/media` is module-mocked so no real network calls are made.
 *     `listAlbums` returns a fake album list so the Select can be populated.
 *     `addAlbumItems` and `addAlbumItemsByFilter` are the two submit paths.
 *   - `CreateAlbumDialog` is stubbed to a lightweight component that calls
 *     `onCreated` immediately — this keeps tests for the inline "create new" flow
 *     simple without re-testing CreateAlbumDialog internals.
 *
 * Test coverage:
 *   1. "Selected" mode: when selectedIds is non-empty and mode is "selected",
 *      submitting calls addAlbumItems(albumId, selectedIds).
 *   2. "All matching" mode: when mode is switched to "all", submitting calls
 *      addAlbumItemsByFilter(albumId, filters).
 *   3. Empty selectedIds: only the "add all" path is shown; submitting calls
 *      addAlbumItemsByFilter.
 *   4. onSuccess is called with a descriptive message after a successful add.
 *   5. onSuccess is called after addAlbumItemsByFilter succeeds.
 *   6. onError is called when addAlbumItems rejects.
 *   7. The submit button is disabled when no album is selected.
 *
 * Note: web deps live in the Docker container, not local node_modules.
 * These tests were NOT run locally — they follow existing Vitest + RTL patterns
 * and are expected to pass in the CI container.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../__tests__/utils/test-utils';
import { AddToAlbumDialog } from '../AddToAlbumDialog';
import type { Album, AddAlbumItemsByFilterDto } from '../../../types/media';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../../services/media', () => ({
  listAlbums: vi.fn(),
  addAlbumItems: vi.fn(),
  addAlbumItemsByFilter: vi.fn(),
  createAlbum: vi.fn(),
  updateAlbum: vi.fn(),
  deleteAlbum: vi.fn(),
  removeAlbumItem: vi.fn(),
  listMedia: vi.fn(),
  getMedia: vi.fn(),
  patchMedia: vi.fn(),
  deleteMedia: vi.fn(),
  listTags: vi.fn(),
  initUpload: vi.fn(),
  uploadPart: vi.fn(),
  completeUpload: vi.fn(),
  registerMedia: vi.fn(),
  exportMedia: vi.fn(),
}));

// Stub CreateAlbumDialog so it does not recurse into its own service calls.
// The stub immediately calls onCreated with a fake album when the dialog opens.
vi.mock('../CreateAlbumDialog', () => ({
  CreateAlbumDialog: ({
    open,
    onCreated,
  }: {
    open: boolean;
    onCreated: (album: Album) => void;
    onClose: () => void;
    circleId: string;
  }) => {
    if (!open) return null;
    const stubAlbum: Album = {
      id: 'album-created-via-stub',
      name: 'Stub Album',
      description: null,
      addedById: 'user-1',
      circleId: 'circle-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Use a button so we can trigger onCreated from tests that need it
    return (
      <button
        data-testid="stub-create-dialog-trigger"
        onClick={() => onCreated(stubAlbum)}
      >
        Stub Create
      </button>
    );
  },
}));

import { listAlbums, addAlbumItems, addAlbumItemsByFilter } from '../../../services/media';

const mockListAlbums = vi.mocked(listAlbums);
const mockAddAlbumItems = vi.mocked(addAlbumItems);
const mockAddAlbumItemsByFilter = vi.mocked(addAlbumItemsByFilter);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CIRCLE_ID = 'circle-uuid-0001';
const ALBUM_ID = 'album-uuid-0001';

const fakeAlbum: Album = {
  id: ALBUM_ID,
  name: 'Vacation 2024',
  description: null,
  addedById: 'user-1',
  circleId: CIRCLE_ID,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const fakeAlbumListResponse = {
  items: [fakeAlbum],
  meta: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 },
};

const emptyFilters: AddAlbumItemsByFilterDto = { circleId: CIRCLE_ID };

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

function buildDefaultProps(overrides: Partial<{
  open: boolean;
  selectedIds: string[];
  filters: AddAlbumItemsByFilterDto;
  matchingCount: number;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
  onClose: () => void;
}> = {}) {
  return {
    open: true,
    circleId: CIRCLE_ID,
    selectedIds: ['item-1', 'item-2'],
    filters: emptyFilters,
    matchingCount: 42,
    onSuccess: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

// Helper: open the album Select and click the given album option by name.
// MUI Select renders a div[role="combobox"] as the clickable trigger; the
// dropdown appears in a portal with role="listbox" once the albums have loaded.
async function selectAlbumByName(user: ReturnType<typeof userEvent.setup>, albumName: string) {
  // Wait for the albums to finish loading before trying to open the Select
  await waitFor(() => {
    expect(screen.getByRole('combobox')).not.toBeDisabled();
  });
  // Open the MUI Select dropdown
  await user.click(screen.getByRole('combobox'));
  // The option list is rendered in a portal
  const listbox = await screen.findByRole('listbox');
  await user.click(within(listbox).getByText(albumName));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AddToAlbumDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAlbums.mockResolvedValue(fakeAlbumListResponse);
  });

  // -------------------------------------------------------------------------
  // "Selected" mode — non-empty selectedIds
  // -------------------------------------------------------------------------

  describe('when selectedIds is non-empty', () => {
    it('defaults to "selected" mode and submit calls addAlbumItems with selected ids', async () => {
      const user = userEvent.setup();
      const props = buildDefaultProps({
        selectedIds: ['item-a', 'item-b'],
      });
      mockAddAlbumItems.mockResolvedValue(undefined);

      render(<AddToAlbumDialog {...props} />);

      // Wait for album list to load
      await selectAlbumByName(user, 'Vacation 2024');

      // Default mode should be "selected" radio
      expect(screen.getByLabelText(/add 2 selected item/i)).toBeChecked();

      await user.click(screen.getByRole('button', { name: /add to album/i }));

      await waitFor(() => {
        expect(mockAddAlbumItems).toHaveBeenCalledTimes(1);
        expect(mockAddAlbumItems).toHaveBeenCalledWith(ALBUM_ID, ['item-a', 'item-b']);
      });

      expect(mockAddAlbumItemsByFilter).not.toHaveBeenCalled();
    });

    it('calls addAlbumItemsByFilter when "all matching" mode is selected', async () => {
      const user = userEvent.setup();
      const filters: AddAlbumItemsByFilterDto = { circleId: CIRCLE_ID, type: 'photo' };
      const props = buildDefaultProps({
        selectedIds: ['item-a'],
        filters,
        matchingCount: 99,
      });
      mockAddAlbumItemsByFilter.mockResolvedValue({ added: 99 });

      render(<AddToAlbumDialog {...props} />);

      await selectAlbumByName(user, 'Vacation 2024');

      // Switch to "all" mode
      await user.click(screen.getByLabelText(/add all 99 items/i));

      await user.click(screen.getByRole('button', { name: /add to album/i }));

      await waitFor(() => {
        expect(mockAddAlbumItemsByFilter).toHaveBeenCalledTimes(1);
        expect(mockAddAlbumItemsByFilter).toHaveBeenCalledWith(ALBUM_ID, filters);
      });

      expect(mockAddAlbumItems).not.toHaveBeenCalled();
    });

    it('calls onSuccess with a message after addAlbumItems succeeds', async () => {
      const user = userEvent.setup();
      const onSuccess = vi.fn();
      const props = buildDefaultProps({
        selectedIds: ['item-a', 'item-b'],
        onSuccess,
      });
      mockAddAlbumItems.mockResolvedValue(undefined);

      render(<AddToAlbumDialog {...props} />);

      await selectAlbumByName(user, 'Vacation 2024');
      await user.click(screen.getByRole('button', { name: /add to album/i }));

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
        // Message should mention how many items and the album name
        expect(onSuccess).toHaveBeenCalledWith(expect.stringContaining('2'));
        expect(onSuccess.mock.calls[0][0]).toMatch(/vacation 2024/i);
      });
    });

    it('calls onError when addAlbumItems rejects', async () => {
      const user = userEvent.setup();
      const onError = vi.fn();
      const props = buildDefaultProps({ onError });
      mockAddAlbumItems.mockRejectedValue(new Error('Network failure'));

      render(<AddToAlbumDialog {...props} />);

      await selectAlbumByName(user, 'Vacation 2024');
      await user.click(screen.getByRole('button', { name: /add to album/i }));

      await waitFor(() => {
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('Network failure'));
      });
    });
  });

  // -------------------------------------------------------------------------
  // Empty selectedIds — only "add all" path
  // -------------------------------------------------------------------------

  describe('when selectedIds is empty', () => {
    it('does not show the radio group — always uses addAlbumItemsByFilter', async () => {
      const user = userEvent.setup();
      const filters: AddAlbumItemsByFilterDto = { circleId: CIRCLE_ID, type: 'video' };
      const props = buildDefaultProps({
        selectedIds: [],
        filters,
        matchingCount: 15,
      });
      mockAddAlbumItemsByFilter.mockResolvedValue({ added: 15 });

      render(<AddToAlbumDialog {...props} />);

      // No radio group — the "add selected" option should not exist
      expect(screen.queryByLabelText(/add \d+ selected/i)).not.toBeInTheDocument();

      // Informational text about adding all matching items should be visible
      await waitFor(() => {
        expect(screen.getByText(/15 items matching current filters/i)).toBeInTheDocument();
      });

      await selectAlbumByName(user, 'Vacation 2024');
      await user.click(screen.getByRole('button', { name: /add to album/i }));

      await waitFor(() => {
        expect(mockAddAlbumItemsByFilter).toHaveBeenCalledTimes(1);
        expect(mockAddAlbumItemsByFilter).toHaveBeenCalledWith(ALBUM_ID, filters);
        expect(mockAddAlbumItems).not.toHaveBeenCalled();
      });
    });

    it('calls onSuccess after addAlbumItemsByFilter succeeds', async () => {
      const user = userEvent.setup();
      const onSuccess = vi.fn();
      const props = buildDefaultProps({
        selectedIds: [],
        matchingCount: 5,
        onSuccess,
      });
      mockAddAlbumItemsByFilter.mockResolvedValue({ added: 5 });

      render(<AddToAlbumDialog {...props} />);

      await selectAlbumByName(user, 'Vacation 2024');
      await user.click(screen.getByRole('button', { name: /add to album/i }));

      await waitFor(() => {
        expect(onSuccess).toHaveBeenCalledTimes(1);
        // Should mention count and album name
        expect(onSuccess).toHaveBeenCalledWith(expect.stringContaining('5'));
        expect(onSuccess.mock.calls[0][0]).toMatch(/vacation 2024/i);
      });
    });

    it('calls onError when addAlbumItemsByFilter rejects', async () => {
      const user = userEvent.setup();
      const onError = vi.fn();
      const props = buildDefaultProps({ selectedIds: [], onError });
      mockAddAlbumItemsByFilter.mockRejectedValue(new Error('Filter error'));

      render(<AddToAlbumDialog {...props} />);

      await selectAlbumByName(user, 'Vacation 2024');
      await user.click(screen.getByRole('button', { name: /add to album/i }));

      await waitFor(() => {
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(expect.stringContaining('Filter error'));
      });
    });
  });

  // -------------------------------------------------------------------------
  // Submit guard — album must be selected
  // -------------------------------------------------------------------------

  it('the "Add to Album" button is disabled when no album is selected', async () => {
    const props = buildDefaultProps();
    render(<AddToAlbumDialog {...props} />);

    // Albums are loading or loaded but none selected
    const submitButton = screen.getByRole('button', { name: /add to album/i });
    expect(submitButton).toBeDisabled();
  });

  // -------------------------------------------------------------------------
  // Dialog closed — not rendered
  // -------------------------------------------------------------------------

  it('does not render dialog content when open is false', () => {
    const props = buildDefaultProps({ open: false });
    render(<AddToAlbumDialog {...props} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
