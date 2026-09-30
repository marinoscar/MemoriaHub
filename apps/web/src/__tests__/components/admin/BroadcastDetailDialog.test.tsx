/**
 * `BroadcastDetailDialog` — epic #481, issue #488.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { BroadcastDetailDialog } from '../../../components/admin/BroadcastDetailDialog';
import { makeBroadcast } from '../../fixtures/broadcasts';

const handlers = {
  onClose: vi.fn(),
  onCancel: vi.fn(),
  onResume: vi.fn(),
  onDelete: vi.fn(),
};

function renderDialog(props: Partial<Parameters<typeof BroadcastDetailDialog>[0]> = {}) {
  return render(
    <BroadcastDetailDialog
      open
      broadcast={makeBroadcast()}
      isLoading={false}
      error={null}
      canWrite
      isWorking={false}
      {...handlers}
      {...props}
    />,
  );
}

describe('BroadcastDetailDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.onCancel.mockResolvedValue(true);
    handlers.onResume.mockResolvedValue(true);
    handlers.onDelete.mockResolvedValue(true);
  });

  it('renders content as plain text split into paragraphs, with progress and creator', () => {
    renderDialog({
      broadcast: makeBroadcast({ body: '<b>One</b>\n\nTwo', link: '/memories', ctaLabel: 'Open' }),
    });
    expect(screen.getByText('<b>One</b>')).toBeInTheDocument();
    expect(screen.getByText('Two')).toBeInTheDocument();
    expect(screen.getByText(/Open → \/memories/)).toBeInTheDocument();
    expect(screen.getByText('10 / 10 recipients')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Broadcast progress' })).toBeInTheDocument();
    expect(screen.getByText('Ada (admin@example.com)')).toBeInTheDocument();
  });

  it('gates actions by status: a sent broadcast can only be deleted', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel broadcast' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  it('disables every action without broadcasts:write', () => {
    renderDialog({ canWrite: false, broadcast: makeBroadcast({ status: 'failed' }) });
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel broadcast' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('confirms a resume of a failed broadcast, naming the duplicate bound', async () => {
    const user = userEvent.setup();
    const failed = makeBroadcast({ status: 'failed', processedCount: 4, lastError: 'boom' });
    renderDialog({ broadcast: failed });
    expect(screen.getByTestId('broadcast-failed-summary')).toHaveTextContent('Stopped after 4 of 10');
    expect(screen.getByText('boom')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resume' }));
    const confirm = await screen.findByRole('dialog', { name: 'Resume this broadcast?' });
    expect(within(confirm).getByText(/may receive it twice/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Resume broadcast' }));

    await waitFor(() => expect(handlers.onResume).toHaveBeenCalledWith(failed));
  });

  it('closes after a confirmed delete', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete this broadcast?' });
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(handlers.onDelete).toHaveBeenCalled());
    await waitFor(() => expect(handlers.onClose).toHaveBeenCalled());
  });

  it('cancels a sending broadcast after confirmation', async () => {
    const user = userEvent.setup();
    renderDialog({ broadcast: makeBroadcast({ status: 'sending', recipientCount: null, processedCount: 0 }) });
    await user.click(screen.getByRole('button', { name: 'Cancel broadcast' }));
    const confirm = await screen.findByRole('dialog', { name: 'Cancel this broadcast?' });
    expect(within(confirm).getByText(/next 25 recipients/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Cancel broadcast' }));
    await waitFor(() => expect(handlers.onCancel).toHaveBeenCalled());
  });

  it('shows loading and error states', () => {
    renderDialog({ broadcast: null, isLoading: true, error: 'Failed to load' });
    expect(screen.getByLabelText('Loading broadcast')).toBeInTheDocument();
    expect(screen.getByText('Failed to load')).toBeInTheDocument();
  });
});
