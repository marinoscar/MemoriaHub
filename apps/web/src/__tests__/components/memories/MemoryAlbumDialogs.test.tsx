/**
 * Component tests — MemoryAlbumDialogs (epic #300, issue #313).
 *
 * The share flow is the interesting one. v1 sharing is ALBUM CHAINING — save
 * the memory as an album, then hand that album id to the existing album share
 * dialog — so the two assertions that matter are (a) the user is told an album
 * is being created before it exists, and (b) exactly ONE album is created. A
 * re-render that re-fires the silent save would litter the library with
 * duplicate albums and nothing would fail loudly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render, mockUser } from '../../utils/test-utils';

vi.mock('../../../services/memories', () => ({
  saveMemoryAsAlbum: vi.fn(),
}));

vi.mock('../../../services/shareService', () => ({
  createShare: vi.fn(),
  updateShare: vi.fn(),
  revokeShare: vi.fn(),
}));

import { MemoryAlbumDialogs } from '../../../components/memories/MemoryAlbumDialogs';
import { saveMemoryAsAlbum } from '../../../services/memories';

const mockSave = vi.mocked(saveMemoryAsAlbum);

function renderDialogs(
  props: Partial<React.ComponentProps<typeof MemoryAlbumDialogs>> = {},
) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  const result = render(
    <MemoryAlbumDialogs
      mode="save"
      memoryId="mem-1"
      memoryTitle="Trip to Guanacaste"
      onClose={onClose}
      onSaved={onSaved}
      {...props}
    />,
    { wrapperOptions: { authenticated: true, user: mockUser } },
  );
  return { ...result, onClose, onSaved };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSave.mockResolvedValue({ albumId: 'album-9' });
});

describe('MemoryAlbumDialogs — save as album', () => {
  it('prefills the name with the memory title', () => {
    renderDialogs();
    expect((screen.getByLabelText('Album name') as HTMLInputElement).value).toBe(
      'Trip to Guanacaste',
    );
  });

  it('saves the edited name and reports the new album', async () => {
    const user = userEvent.setup();
    const { onSaved, onClose } = renderDialogs();

    const field = screen.getByLabelText('Album name');
    await user.clear(field);
    await user.type(field, 'Guanacaste 2023');
    await user.click(screen.getByRole('button', { name: /save album/i }));

    await waitFor(() =>
      expect(mockSave).toHaveBeenCalledWith('mem-1', 'Guanacaste 2023'),
    );
    expect(onSaved).toHaveBeenCalledWith('album-9', 'save');
    expect(onClose).toHaveBeenCalled();
  });

  it('refuses an empty name rather than sending one the API would reject', async () => {
    const user = userEvent.setup();
    renderDialogs();

    await user.clear(screen.getByLabelText('Album name'));
    expect(screen.getByRole('button', { name: /save album/i })).toBeDisabled();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('surfaces a failure in place and keeps the dialog open', async () => {
    const user = userEvent.setup();
    mockSave.mockRejectedValue(new Error('Album limit reached'));
    const { onClose } = renderDialogs();

    await user.click(screen.getByRole('button', { name: /save album/i }));

    expect(await screen.findByText('Album limit reached')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('MemoryAlbumDialogs — share via album', () => {
  it('explains the album it is about to create, then hands off to the share flow', async () => {
    renderDialogs({ mode: 'share' });

    expect(
      screen.getByText(/Memories are shared as an album/i),
    ).toBeInTheDocument();

    await waitFor(() => expect(mockSave).toHaveBeenCalledWith('mem-1', 'Trip to Guanacaste'));
    // The existing album share dialog takes over from here.
    expect(await screen.findByText('Share publicly')).toBeInTheDocument();
  });

  it('creates exactly one album even across re-renders', async () => {
    const { rerender } = renderDialogs({ mode: 'share' });

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));

    rerender(
      <MemoryAlbumDialogs
        mode="share"
        memoryId="mem-1"
        memoryTitle="Trip to Guanacaste"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
  });

  it('does not announce a snackbar-worthy save for the silent share step', async () => {
    const { onSaved } = renderDialogs({ mode: 'share' });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('album-9', 'share'));
    // The owner distinguishes on the mode; the album is an implementation
    // detail of the link the user actually asked for.
    expect(onSaved).not.toHaveBeenCalledWith('album-9', 'save');
  });

  it('reports a failed save instead of opening an empty share dialog', async () => {
    mockSave.mockRejectedValue(new Error('Could not create the album'));
    renderDialogs({ mode: 'share' });

    expect(await screen.findByText('Could not create the album')).toBeInTheDocument();
    expect(screen.queryByText('Share publicly')).not.toBeInTheDocument();
  });
});

describe('MemoryAlbumDialogs — closed', () => {
  it('renders nothing and saves nothing when no mode is set', () => {
    renderDialogs({ mode: null });
    expect(screen.queryByLabelText('Album name')).not.toBeInTheDocument();
    expect(mockSave).not.toHaveBeenCalled();
  });
});
