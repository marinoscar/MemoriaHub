/**
 * The broadcast composer — epic #481, issue #488 (ported from the reference
 * implementation). What is under test is every guard between an administrator
 * and a send they did not mean: no channels, critical ⇒ inbox, a past
 * schedule, the link rules, the confirmation step, and test-to-me.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';

vi.mock('../../../services/pushDiagnostics', () => ({
  getNotificationClientConfig: vi.fn(),
}));

import { getNotificationClientConfig } from '../../../services/pushDiagnostics';
import {
  BroadcastComposer,
  earliestSchedule,
  validateLink,
} from '../../../components/admin/BroadcastComposer';

const mockConfig = vi.mocked(getNotificationClientConfig);

const onSubmit = vi.fn();
const onSendTest = vi.fn();
const onClose = vi.fn();

function renderComposer(overrides: { audience?: number | null; isWorking?: boolean } = {}) {
  return render(
    <BroadcastComposer
      open
      onClose={onClose}
      audience={overrides.audience === undefined ? 1284 : overrides.audience}
      isWorking={overrides.isWorking ?? false}
      onSubmit={onSubmit}
      onSendTest={onSendTest}
    />,
  );
}

const submitButton = () => screen.getByRole('button', { name: /^send…$|^schedule…$/i });

async function compose(user: ReturnType<typeof userEvent.setup>, body = 'We will be offline from 01:00.') {
  await user.type(screen.getByLabelText(/^title/i), 'Planned maintenance');
  await user.type(screen.getByLabelText(/^body/i), body);
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}
function localValue(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

// Typing-heavy flows: give each test headroom when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });

describe('BroadcastComposer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.mockResolvedValue({
      pushEnabled: true,
      vapidPublicKey: 'key',
      browserEnabled: true,
      pushTypes: [],
    });
    onSubmit.mockResolvedValue(true);
    onSendTest.mockResolvedValue({
      notificationType: 'admin_broadcast',
      channels: ['inbox'],
      sentToUserId: 'u1',
      email: null,
    });
  });

  describe('validation helpers', () => {
    it('accepts root-relative links and refuses the rest with a reason', () => {
      expect(validateLink('')).toBeNull();
      expect(validateLink('/memories')).toBeNull();
      expect(validateLink('https://example.com')).toMatch(/start with "\/"/);
      expect(validateLink('//evil.example')).toMatch(/another site/);
      expect(validateLink('/\\evil')).toMatch(/another site/);
      expect(validateLink('/a b')).toMatch(/spaces/);
      expect(validateLink(`/${'a'.repeat(600)}`)).toMatch(/500 characters/);
    });

    it('computes the earliest schedule as one minute from now', () => {
      const now = new Date(2026, 0, 2, 3, 4);
      expect(earliestSchedule(now)).toBe('2026-01-02T03:05');
    });
  });

  describe('channels', () => {
    it('defaults to Inbox and disables submit once every channel is cleared', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);

      expect(screen.getByRole('checkbox', { name: 'Inbox' })).toBeChecked();
      expect(submitButton()).toBeEnabled();

      await user.click(screen.getByRole('checkbox', { name: 'Inbox' }));
      expect(submitButton()).toBeDisabled();
      expect(screen.getByText(/select at least one channel/i)).toBeInTheDocument();
    });

    it('disables Push when web push is off for the deployment', async () => {
      mockConfig.mockResolvedValue({
        pushEnabled: false,
        vapidPublicKey: null,
        browserEnabled: true,
        pushTypes: [],
      });
      renderComposer();

      await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Push' })).toBeDisabled());
    });

    it('leaves Push selectable when the config cannot be read', async () => {
      mockConfig.mockRejectedValue(new Error('nope'));
      renderComposer();

      await waitFor(() => expect(mockConfig).toHaveBeenCalled());
      expect(screen.getByRole('checkbox', { name: 'Push' })).toBeEnabled();
    });
  });

  it('requires Inbox for Push: clearing Inbox clears and disables Push', async () => {
    const user = userEvent.setup();
    renderComposer();
    await compose(user);
    await user.click(screen.getByRole('checkbox', { name: 'Push' }));
    await user.click(screen.getByRole('checkbox', { name: 'Email' }));

    await user.click(screen.getByRole('checkbox', { name: 'Inbox' }));
    const push = screen.getByRole('checkbox', { name: 'Push' });
    expect(push).not.toBeChecked();
    expect(push).toBeDisabled();

    await user.click(submitButton());
    await user.click(await screen.findByRole('button', { name: 'Send broadcast' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ channels: ['email'] })),
    );
  });

  describe('importance', () => {
    it('forces Inbox on and locks it, and sends critical: true', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);
      await user.click(screen.getByRole('checkbox', { name: 'Push' }));

      await user.click(screen.getByLabelText(/important/i));
      const inbox = screen.getByRole('checkbox', { name: 'Inbox' });
      expect(inbox).toBeChecked();
      expect(inbox).toBeDisabled();

      await user.click(submitButton());
      const confirm = await screen.findByRole('dialog', { name: /send this to everyone/i });
      expect(within(confirm).getByText(/bypassing notification preferences/i)).toBeInTheDocument();
      await user.click(within(confirm).getByRole('button', { name: 'Send broadcast' }));

      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith({
          title: 'Planned maintenance',
          body: 'We will be offline from 01:00.',
          critical: true,
          channels: ['inbox', 'push'],
        }),
      );
    });
  });

  describe('schedule', () => {
    it('blocks submit while the schedule is empty or in the past', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);
      await user.click(screen.getByLabelText('Schedule for later'));

      expect(submitButton()).toBeDisabled();

      const past = new Date(Date.now() - 60 * 60 * 1000);
      await user.type(screen.getByLabelText('Send at'), localValue(past));
      expect(submitButton()).toBeDisabled();
      expect(screen.getByText(/pick a time in the future/i)).toBeInTheDocument();
    });

    it('sends an ISO instant for a future wall-clock time', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);
      await user.click(screen.getByLabelText('Schedule for later'));

      const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
      future.setSeconds(0, 0);
      await user.type(screen.getByLabelText('Send at'), localValue(future));
      expect(screen.getByText(/UTC\.$/)).toBeInTheDocument();

      await user.click(submitButton());
      const confirm = await screen.findByRole('dialog', { name: /schedule this broadcast/i });
      await user.click(within(confirm).getByRole('button', { name: 'Schedule broadcast' }));

      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ scheduledFor: future.toISOString() }),
        ),
      );
    });
  });

  describe('content', () => {
    it('splits the preview body on blank lines', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user, 'First paragraph.{Enter}{Enter}Second paragraph.');

      const preview = screen.getByTestId('broadcast-preview');
      expect(within(preview).getByText('First paragraph.')).toBeInTheDocument();
      expect(within(preview).getByText('Second paragraph.')).toBeInTheDocument();
    });

    it('names the audience and channels, and never says zero before the count resolves', async () => {
      renderComposer({ audience: null });
      expect(screen.getByText('Goes to all active users over Inbox.')).toBeInTheDocument();
    });

    it('shows the resolved audience count', () => {
      renderComposer({ audience: 1284 });
      expect(screen.getByText(/goes to all 1,284 active users over Inbox/i)).toBeInTheDocument();
    });

    it('keeps the button label disabled until a link is present, and sends both', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);
      const label = screen.getByLabelText('Button label');
      expect(label).toBeDisabled();

      await user.type(screen.getByLabelText(/link \(optional\)/i), '/memories');
      expect(label).toBeEnabled();
      await user.type(label, 'Open');

      await user.click(submitButton());
      await user.click(await screen.findByRole('button', { name: 'Send broadcast' }));
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ link: '/memories', ctaLabel: 'Open' }),
        ),
      );
    });

    it('refuses an external link on blur and blocks submit', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);
      await user.type(screen.getByLabelText(/link \(optional\)/i), 'https://example.com');
      await user.tab();

      expect(screen.getByText(/must point inside this application/i)).toBeInTheDocument();
      expect(submitButton()).toBeDisabled();
    });
  });

  describe('test send', () => {
    it('posts the composition and leaves the dialog open', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);

      await user.click(screen.getByRole('button', { name: /send test to me/i }));

      await waitFor(() => expect(onSendTest).toHaveBeenCalledTimes(1));
      expect(await screen.findByText(/test sent to you only/i)).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('warns when the test email could not be delivered', async () => {
      const user = userEvent.setup();
      onSendTest.mockResolvedValue({
        notificationType: 'admin_broadcast',
        channels: ['inbox', 'email'],
        sentToUserId: 'u1',
        email: { success: false, error: 'SMTP refused' },
      });
      renderComposer();
      await compose(user);

      await user.click(screen.getByRole('button', { name: /send test to me/i }));

      expect(await screen.findByText(/email could not be delivered: SMTP refused/i)).toBeInTheDocument();
    });

    it('shows nothing when the test send failed (the page reports the error)', async () => {
      const user = userEvent.setup();
      onSendTest.mockResolvedValue(null);
      renderComposer();
      await compose(user);

      await user.click(screen.getByRole('button', { name: /send test to me/i }));

      await waitFor(() => expect(onSendTest).toHaveBeenCalled());
      expect(screen.queryByText(/test sent to you only/i)).not.toBeInTheDocument();
    });

    it('is disabled until the composition is valid', () => {
      renderComposer();
      expect(screen.getByRole('button', { name: /send test to me/i })).toBeDisabled();
    });
  });

  describe('confirmation', () => {
    it('backs out without sending', async () => {
      const user = userEvent.setup();
      renderComposer();
      await compose(user);
      await user.click(submitButton());
      await user.click(await screen.findByRole('button', { name: 'Back' }));

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('closes once the send is accepted, and stays open when refused', async () => {
      const user = userEvent.setup();
      onSubmit.mockResolvedValueOnce(false);
      renderComposer();
      await compose(user);

      await user.click(submitButton());
      await user.click(await screen.findByRole('button', { name: 'Send broadcast' }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      expect(onClose).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: /send this to everyone/i })).not.toBeInTheDocument(),
      );

      await user.click(submitButton());
      await user.click(await screen.findByRole('button', { name: 'Send broadcast' }));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    });
  });
});
