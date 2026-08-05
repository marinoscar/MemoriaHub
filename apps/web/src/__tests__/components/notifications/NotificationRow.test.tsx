/**
 * Unit tests for NotificationRow (issue #249).
 *
 * Isolated at the component level — no store/service mocking needed, just
 * the two callback props. The case this file exists for: the dismiss (×)
 * button sits OUTSIDE the row's ListItemButton (MUI `secondaryAction`), so
 * clicking it must call `onDismiss` and must NOT also call `onOpen`.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import { NotificationRow } from '../../../components/notifications/NotificationRow';
import type { NotificationItem } from '../../../types/notifications';

function makeNotification(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'notif-1',
    circleId: 'circle-1',
    type: 'review_queue_bursts',
    title: 'Burst review ready',
    body: 'Three bursts are waiting for review.',
    link: '/bursts',
    data: null,
    readAt: null,
    dismissedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('NotificationRow', () => {
  it('renders the title and body', () => {
    const notification = makeNotification();
    render(
      <NotificationRow notification={notification} onOpen={vi.fn()} onDismiss={vi.fn()} />,
    );

    expect(screen.getByText('Burst review ready')).toBeInTheDocument();
    expect(screen.getByText('Three bursts are waiting for review.')).toBeInTheDocument();
  });

  it('calls onOpen with the notification when the row body is clicked', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const notification = makeNotification();
    render(<NotificationRow notification={notification} onOpen={onOpen} onDismiss={vi.fn()} />);

    await user.click(screen.getByText('Burst review ready'));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(notification);
  });

  it('calls onDismiss (not onOpen) when the dismiss (×) button is clicked', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    const notification = makeNotification();
    render(
      <NotificationRow notification={notification} onOpen={onOpen} onDismiss={onDismiss} />,
    );

    const dismissButton = screen.getByRole('button', {
      name: 'Dismiss notification: Burst review ready',
    });
    await user.click(dismissButton);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledWith(notification);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('stops propagation so a raw (non-user-event) click on dismiss never bubbles into the row', () => {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    const notification = makeNotification();
    render(
      <NotificationRow notification={notification} onOpen={onOpen} onDismiss={onDismiss} />,
    );

    const dismissButton = screen.getByRole('button', {
      name: 'Dismiss notification: Burst review ready',
    });
    fireEvent.click(dismissButton);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shows an "Unread" indicator for an unread notification', () => {
    const notification = makeNotification({ readAt: null });
    render(<NotificationRow notification={notification} onOpen={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.getByText('Unread')).toBeInTheDocument();
  });

  it('does not show an "Unread" indicator once read', () => {
    const notification = makeNotification({ readAt: new Date().toISOString() });
    render(<NotificationRow notification={notification} onOpen={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.queryByText('Unread')).not.toBeInTheDocument();
  });
});
