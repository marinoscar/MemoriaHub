/**
 * Tests for the app's NotificationBell binding (RETRO-D3, #576).
 *
 * The bell itself (badge, list, mark-read, dismiss, stream) is the platform's
 * and is tested in its package. What this app adds is the footer link to the
 * full inbox, so the packaged bell is stubbed to render the footer slot.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { render } from '../../utils/test-utils';

const close = vi.fn();

vi.mock('@marinoscar/platform-web/notifications/ui', () => ({
  NotificationBell: ({ slots }: { slots?: { footer?: (args: { close: () => void }) => ReactNode } }) => (
    <div data-testid="platform-bell">{slots?.footer?.({ close })}</div>
  ),
}));

import { NotificationBell } from '../../../components/notifications/NotificationBell';

describe('NotificationBell', () => {
  it('renders the packaged bell with a footer link to the full inbox', async () => {
    render(<NotificationBell />);

    expect(screen.getByTestId('platform-bell')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'View all notifications' });
    expect(link).toHaveAttribute('href', '/notifications');

    await userEvent.click(link);
    expect(close).toHaveBeenCalled();
  });
});
