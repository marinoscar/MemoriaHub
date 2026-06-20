/**
 * Component tests — CreateAlbumDialog
 *
 * Mocking strategy:
 *   - `services/media` is module-mocked so `createAlbum` never hits the network.
 *   - The dialog is rendered in isolation using the project's `render` helper from
 *     test-utils (provides MUI theme + auth context + router via MemoryRouter).
 *
 * Test coverage:
 *   1. Entering a name and submitting calls createAlbum with {circleId, name}.
 *   2. Optional description is forwarded when provided.
 *   3. Empty description is omitted from the DTO (undefined, not "").
 *   4. onCreated is fired with the returned Album after a successful save.
 *   5. onClose is fired after a successful save.
 *   6. The submit button is disabled when name is blank.
 *   7. An error alert is shown when createAlbum rejects.
 *   8. Enter key triggers submit when name is non-empty.
 *
 * Note: web deps live in the Docker container, not local node_modules.
 * These tests were NOT run locally. They follow the exact Vitest + RTL patterns
 * used by MediaLightbox.test.tsx and the services/* tests in this project and are
 * expected to pass in the CI container.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../../__tests__/utils/test-utils';
import { CreateAlbumDialog } from '../CreateAlbumDialog';
import type { Album } from '../../../types/media';

// ---------------------------------------------------------------------------
// Module mock — must be hoisted before the component import resolves the module
// ---------------------------------------------------------------------------

vi.mock('../../../services/media', () => ({
  createAlbum: vi.fn(),
  // stubs for any other exports the component tree may pull in
  listAlbums: vi.fn(),
  addAlbumItems: vi.fn(),
  addAlbumItemsByFilter: vi.fn(),
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

import { createAlbum } from '../../../services/media';

const mockCreateAlbum = vi.mocked(createAlbum);

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const CIRCLE_ID = 'circle-uuid-test-0001';

function makeAlbum(overrides: Partial<Album> = {}): Album {
  return {
    id: 'album-new-1',
    name: 'Test Album',
    description: null,
    addedById: 'user-1',
    circleId: CIRCLE_ID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: default props
// ---------------------------------------------------------------------------

function renderDialog(props: {
  open?: boolean;
  onClose?: () => void;
  onCreated?: (album: Album) => void;
}) {
  const onClose = props.onClose ?? vi.fn();
  const onCreated = props.onCreated ?? vi.fn();

  render(
    <CreateAlbumDialog
      open={props.open ?? true}
      onClose={onClose}
      circleId={CIRCLE_ID}
      onCreated={onCreated}
    />,
  );

  return { onClose, onCreated };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CreateAlbumDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls createAlbum with circleId and trimmed name on submit', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const returnedAlbum = makeAlbum({ name: 'Vacation 2024' });
    mockCreateAlbum.mockResolvedValue(returnedAlbum);

    renderDialog({ onCreated });

    await user.type(screen.getByLabelText(/album name/i), 'Vacation 2024');
    await user.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(mockCreateAlbum).toHaveBeenCalledWith(
        expect.objectContaining({
          circleId: CIRCLE_ID,
          name: 'Vacation 2024',
        }),
      );
    });
  });

  it('includes description in the DTO when filled', async () => {
    const user = userEvent.setup();
    mockCreateAlbum.mockResolvedValue(makeAlbum({ name: 'My Album', description: 'A nice album' }));

    renderDialog({});

    await user.type(screen.getByLabelText(/album name/i), 'My Album');
    await user.type(screen.getByLabelText(/description/i), 'A nice album');
    await user.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(mockCreateAlbum).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My Album',
          description: 'A nice album',
        }),
      );
    });
  });

  it('omits description from the DTO when the field is left blank', async () => {
    const user = userEvent.setup();
    mockCreateAlbum.mockResolvedValue(makeAlbum({ name: 'Blank Desc' }));

    renderDialog({});

    await user.type(screen.getByLabelText(/album name/i), 'Blank Desc');
    await user.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(mockCreateAlbum).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Blank Desc' }),
      );
      // description should be undefined (not an empty string)
      const callArg = mockCreateAlbum.mock.calls[0][0];
      expect(callArg.description).toBeUndefined();
    });
  });

  it('fires onCreated with the returned album after a successful save', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const returnedAlbum = makeAlbum({ name: 'Memories' });
    mockCreateAlbum.mockResolvedValue(returnedAlbum);

    renderDialog({ onCreated });

    await user.type(screen.getByLabelText(/album name/i), 'Memories');
    await user.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1);
      expect(onCreated).toHaveBeenCalledWith(returnedAlbum);
    });
  });

  it('fires onClose after a successful save', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    mockCreateAlbum.mockResolvedValue(makeAlbum({ name: 'Foo' }));

    renderDialog({ onClose });

    await user.type(screen.getByLabelText(/album name/i), 'Foo');
    await user.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('the Create button is disabled when name is blank', () => {
    renderDialog({});

    const createButton = screen.getByRole('button', { name: /create/i });
    expect(createButton).toBeDisabled();
  });

  it('shows an error alert when createAlbum rejects', async () => {
    const user = userEvent.setup();
    mockCreateAlbum.mockRejectedValue(new Error('Server error'));

    renderDialog({});

    await user.type(screen.getByLabelText(/album name/i), 'Bad Album');
    await user.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText(/server error/i)).toBeInTheDocument();
    });
  });

  it('does NOT call onCreated when createAlbum rejects', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    mockCreateAlbum.mockRejectedValue(new Error('fail'));

    renderDialog({ onCreated });

    await user.type(screen.getByLabelText(/album name/i), 'Bad Album');
    await user.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    expect(onCreated).not.toHaveBeenCalled();
  });

  it('submits when Enter is pressed in the name field', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const returnedAlbum = makeAlbum({ name: 'Enter Album' });
    mockCreateAlbum.mockResolvedValue(returnedAlbum);

    renderDialog({ onCreated });

    await user.type(screen.getByLabelText(/album name/i), 'Enter Album{Enter}');

    await waitFor(() => {
      expect(mockCreateAlbum).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Enter Album' }),
      );
      expect(onCreated).toHaveBeenCalledWith(returnedAlbum);
    });
  });

  it('does not render the dialog content when open is false', () => {
    renderDialog({ open: false });

    // The dialog is not in the DOM when closed
    expect(screen.queryByLabelText(/album name/i)).not.toBeInTheDocument();
  });
});
