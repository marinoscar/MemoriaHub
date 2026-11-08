/**
 * `/settings` (RETRO-B5, #621): the per-user hub, a binding over the packaged
 * `SettingsHub` driven by `USER_SETTINGS_SECTIONS`.
 */
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { render, mockUser } from '../utils/test-utils';
import UserSettingsHubPage from '../../pages/UserSettingsHubPage';

function LocationProbe() {
  const { pathname, hash } = useLocation();
  return <div data-testid="location">{`${pathname}${hash}`}</div>;
}

function renderHub(route = '/settings', permissions: string[] = mockUser.permissions) {
  return render(
    <>
      <UserSettingsHubPage />
      <LocationProbe />
    </>,
    { wrapperOptions: { route, user: { ...mockUser, permissions } } },
  );
}

describe('UserSettingsHubPage', () => {
  it('renders the packaged hub with the account, Android and security cards', () => {
    renderHub();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    for (const title of [
      'Profile',
      'Appearance',
      'Time zone',
      'Notifications',
      'Memories',
      'Search',
      'Android app',
      'Access Tokens',
    ]) {
      expect(screen.getByText(title)).toBeInTheDocument();
    }
    expect(screen.getByRole('textbox', { name: 'Search settings' })).toBeInTheDocument();
  });

  it('hides Media sync from a user without media:read', () => {
    renderHub();
    expect(screen.queryByText('Media sync')).not.toBeInTheDocument();
  });

  it('shows Media sync to a media:read holder', () => {
    renderHub('/settings', [...mockUser.permissions, 'media:read']);
    expect(screen.getByText('Media sync')).toBeInTheDocument();
  });

  it('navigates to a card page', async () => {
    const user = userEvent.setup();
    renderHub();
    await user.click(screen.getByText('Time zone'));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/settings/time-zone'));
  });

  it.each([
    ['#notifications', '/settings/notifications'],
    ['#search-fields', '/settings/search'],
    ['#android-app', '/settings/android-app'],
  ])('redirects the stacked page’s %s deep link to its card page', async (hash, target) => {
    renderHub(`/settings${hash}`);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(target));
  });

  it('ignores an unknown hash', () => {
    renderHub('/settings#toString');
    expect(screen.getByTestId('location')).toHaveTextContent('/settings#toString');
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });
});
