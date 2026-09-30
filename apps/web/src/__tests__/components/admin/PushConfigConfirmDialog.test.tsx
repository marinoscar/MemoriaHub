/**
 * `PushConfigConfirmDialog` — epic #481, issue #487. The page suite drives the
 * dialog end to end; this one pins its standalone contract.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { PushConfigConfirmDialog } from '../../../components/admin/PushConfigConfirmDialog';

describe('PushConfigConfirmDialog', () => {
  it('renders nothing when closed', () => {
    render(
      <PushConfigConfirmDialog action={null} isWorking={false} error={null} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('confirms only once the exact literal is typed', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <PushConfigConfirmDialog action="rotate" isWorking={false} error={null} onConfirm={onConfirm} onClose={vi.fn()} />,
    );

    const submit = screen.getByRole('button', { name: 'Rotate keys' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Type ROTATE to confirm'), 'ROTATE');
    await user.click(submit);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows the action error and the working state', () => {
    render(
      <PushConfigConfirmDialog action="remove" isWorking error="It failed" onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByText('It failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('describes remove as deleting the key pair', () => {
    render(
      <PushConfigConfirmDialog action="remove" isWorking={false} error={null} onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    expect(screen.getByText(/deletes the stored key pair entirely/i)).toBeInTheDocument();
  });
});
