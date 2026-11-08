/**
 * `Layout` — the app's binding of the packaged `ShellLayout` (RETRO-F1, #571).
 *
 * Pins the slots: the AppBar, rail and bottom-bar bindings; the shell-wide
 * banners above the page (dropped in the full-bleed variant); the time-zone
 * prompt overlay; the page as the outlet; the shell providers around it all;
 * and that a page asking for `useShellMainVariant('full-bleed')` gets it.
 * Which navigation surface mounts at which width is `navigation/breakpoints`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { useShellMainVariant } from '@marinoscar/platform-web/shell/headless';
import { Layout } from '../../../components/common/Layout';
import { useMediaRefresh } from '../../../contexts/MediaRefreshContext';
import { renderShell } from '../../utils/shell-harness';

vi.mock('@marinoscar/platform-web/host/ui', () => ({
  MaintenanceBanner: () => <div data-testid="maintenance-banner" />,
}));
vi.mock('../../../components/navigation/AppBar', () => ({
  AppBar: () => <header data-testid="app-bar" />,
}));
vi.mock('../../../components/navigation/NavigationRail', () => ({
  NavigationRail: () => <nav data-testid="rail" />,
}));
vi.mock('../../../components/navigation/BottomNav', () => ({
  BottomNav: () => <nav data-testid="bottom-nav" />,
}));
vi.mock('../../../components/notifications/NotificationPermissionBanner', () => ({
  NotificationPermissionBanner: () => <div data-testid="permission-banner" />,
}));
vi.mock('../../../components/common/AndroidUpdateBanner', () => ({
  AndroidUpdateBanner: () => <div data-testid="android-banner" />,
}));
vi.mock('../../../components/settings/TimezonePrompt', () => ({
  TimezonePrompt: () => <div data-testid="timezone-prompt" />,
}));
vi.mock('../../../hooks/usePushSubscriptionSync', () => ({
  usePushSubscriptionSync: vi.fn(() => ({
    config: null,
    capability: 'unsupported',
    requestPermission: vi.fn(),
    isRequestingPermission: false,
  })),
}));
vi.mock('../../../hooks/useNotificationClickHandling', () => ({
  useNotificationClickHandling: vi.fn(),
}));

import { usePushSubscriptionSync } from '../../../hooks/usePushSubscriptionSync';
import { useNotificationClickHandling } from '../../../hooks/useNotificationClickHandling';

function Page() {
  // Inside the shell providers: the refresh context is the real one.
  const { triggerRefresh } = useMediaRefresh();
  return <p data-testid="page">{typeof triggerRefresh}</p>;
}

function MapLikePage() {
  useShellMainVariant('full-bleed');
  return <p data-testid="page">map</p>;
}

function renderLayout(route = '/', width = 1280) {
  return renderShell(
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Page />} />
        <Route path="/map" element={<MapLikePage />} />
      </Route>
    </Routes>,
    { route, width },
  );
}

function main() {
  return document.querySelector('main') as HTMLElement;
}

describe('Layout (packaged ShellLayout binding)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the AppBar, the page, the banners and the time-zone prompt', () => {
    renderLayout('/');
    expect(screen.getByTestId('app-bar')).toBeInTheDocument();
    expect(screen.getByTestId('page')).toHaveTextContent('function');
    for (const id of ['maintenance-banner', 'permission-banner', 'android-banner']) {
      expect(main()).toContainElement(screen.getByTestId(id));
    }
    expect(screen.getByTestId('timezone-prompt')).toBeInTheDocument();
    expect(main()).toHaveAttribute('data-main-variant', 'padded');
  });

  it('mounts the push sync and notification-click handling once', () => {
    renderLayout('/');
    expect(vi.mocked(usePushSubscriptionSync)).toHaveBeenCalled();
    expect(vi.mocked(useNotificationClickHandling)).toHaveBeenCalled();
  });

  it('gives a page that asks for it the full-bleed main, without the banners', () => {
    renderLayout('/map');
    expect(main()).toHaveAttribute('data-main-variant', 'full-bleed');
    expect(screen.queryByTestId('maintenance-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('permission-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('android-banner')).not.toBeInTheDocument();
    // The rail stays: the shell is not remounted for the map.
    expect(screen.getByTestId('rail')).toBeInTheDocument();
  });

  it('mounts the rail at sm and up, the bottom bar below', () => {
    const { unmount } = renderLayout('/', 600);
    expect(screen.getByTestId('rail')).toBeInTheDocument();
    expect(screen.queryByTestId('bottom-nav')).not.toBeInTheDocument();
    unmount();
    renderLayout('/', 599);
    expect(screen.queryByTestId('rail')).not.toBeInTheDocument();
    expect(screen.getByTestId('bottom-nav')).toBeInTheDocument();
  });
});
