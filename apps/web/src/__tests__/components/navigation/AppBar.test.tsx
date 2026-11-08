/**
 * The top bar — the app's binding of the packaged `ShellAppBar` (RETRO-F1,
 * #571; the bar's design is issue #392 / #402, the drill-down spec §4.4).
 *
 * Pins the slots this app fills and the drill-down it inherits: the logo and
 * circle chip in the brand, the search pill at `sm` and up only, the bell in
 * both treatments, Upload outside the drill-down, and below `sm` on a settings
 * route a Back arrow (structural up, never history) plus the resolved page
 * title with the chip, upload and search gone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { AppBar } from '../../../components/navigation/AppBar';
import { APP_NAME } from '../../../constants/app';
import type { Circle } from '../../../types/circles';
import { renderShell } from '../../utils/shell-harness';

vi.mock('../../../contexts/SearchContext', () => ({
  useSearch: vi.fn(() => ({
    messages: [],
    results: null,
    isSearching: false,
    error: null,
    searchRequest: null,
    runAgentSearch: vi.fn(),
    runDeterministicSearch: vi.fn(),
    clearSearch: vi.fn(),
  })),
  SearchProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../../components/search/SearchPanel', () => ({ SearchPanel: vi.fn(() => null) }));
vi.mock('../../../components/media/MediaUploadDialog', () => ({
  MediaUploadDialog: vi.fn(({ open }: { open: boolean }) =>
    open ? <div data-testid="upload-dialog" /> : null,
  ),
}));
vi.mock('../../../components/notifications/NotificationBell', () => ({
  NotificationBell: () => <button type="button" aria-label="Notifications" />,
}));
vi.mock('../../../hooks/useCircle', () => ({ useCircle: vi.fn() }));

import { useCircle } from '../../../hooks/useCircle';

const circle: Circle = {
  id: 'circle-1',
  name: 'Family Circle',
  description: null,
  ownerId: 'test-user-id',
  isPersonal: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function LocationProbe() {
  const { pathname } = useLocation();
  return <output data-testid="location">{pathname}</output>;
}

function renderBar(route: string, width: number) {
  return renderShell(
    <>
      <AppBar />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </>,
    { route, width, admin: true },
  );
}

describe('AppBar (packaged ShellAppBar binding)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useCircle).mockReturnValue({
      circles: [circle],
      activeCircle: circle,
      activeCircleId: circle.id,
      activeCircleRole: 'circle_admin',
      loading: false,
      setActiveCircle: vi.fn(),
      refreshCircles: vi.fn(),
    } as unknown as ReturnType<typeof useCircle>);
  });

  it('carries the logo, the circle chip, the bell and Upload at desktop width', () => {
    renderBar('/', 1280);
    expect(screen.getByRole('img', { name: APP_NAME })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Active circle: Family Circle/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload media' })).toHaveTextContent('Upload');
    expect(screen.getByRole('button', { name: 'toggle theme' })).toBeInTheDocument();
  });

  it.each([600, 700, 1280])('renders the search pill at %dpx (sm and up)', (px) => {
    renderBar('/', px);
    expect(screen.getByLabelText('Search your photos')).toBeInTheDocument();
  });

  it.each([360, 599])('omits the search pill at %dpx (Search is a bottom-bar tab there)', (px) => {
    renderBar('/', px);
    expect(screen.queryByLabelText('Search your photos')).not.toBeInTheDocument();
    // The phone Upload is the icon button.
    expect(screen.getByRole('button', { name: 'Upload media' })).not.toHaveTextContent('Upload');
  });

  it('opening the circle chip does not navigate home (the brand click is contained)', () => {
    renderBar('/albums', 1280);
    fireEvent.click(screen.getByRole('button', { name: /Active circle/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/albums');
  });

  describe('settings drill-down (below sm only)', () => {
    it('shows Back and the resolved title on an admin page, and drops chip / upload / search', () => {
      renderBar('/admin/settings/jobs', 390);
      expect(screen.getByText('Job Queue')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Active circle/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Upload media' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Search your photos')).not.toBeInTheDocument();
      // The bell stays in both treatments.
      expect(screen.getByRole('button', { name: 'Notifications' })).toBeInTheDocument();
    });

    it('Back from a detail page goes to the hub, from the hub to /', () => {
      renderBar('/admin/settings/jobs', 390);
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(screen.getByTestId('location')).toHaveTextContent('/admin/settings');
      fireEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/);
    });

    it('drills down on the per-user settings surface too', () => {
      renderBar('/settings/appearance', 390);
      expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    });

    it('is not drawn at 700px (in-band, rail present) even on /admin/*', () => {
      renderBar('/admin/settings/jobs', 700);
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
      expect(screen.getByLabelText('Search your photos')).toBeInTheDocument();
    });
  });
});
