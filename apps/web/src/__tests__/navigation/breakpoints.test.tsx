/**
 * Cross-cutting breakpoint sweep (issue #402), over the PACKAGED shell since
 * RETRO-F1 (#571).
 *
 * The five coupled gates now live in `@marinoscar/platform-web`; what this
 * file guards is the app's binding of them: rendered through the real
 * `Layout` with the REAL rail and bottom-bar bindings, exactly one primary
 * navigation surface mounts at every width (rail at 600px and up, bottom bar
 * below), and the Collections context pane appears only beside the expanded
 * rail (1200px and up). Widths sample both sides of 600, 900 and 1200, not
 * only the values the implementation happens to use: the matchMedia stub
 * evaluates the real `min-width` / `max-width` in each query, so a wrong
 * threshold fails here.
 *
 * `__tests__/config/breakpointGates.test.ts` is the static half: no app file
 * may grow a sixth breakpoint read in the chrome.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Layout } from '../../components/common/Layout';
import { renderShell } from '../utils/shell-harness';

vi.mock('@marinoscar/platform-web/host/ui', () => ({ MaintenanceBanner: () => null }));
vi.mock('../../components/navigation/AppBar', () => ({ AppBar: () => <header /> }));
vi.mock('../../components/notifications/NotificationPermissionBanner', () => ({
  NotificationPermissionBanner: () => null,
}));
vi.mock('../../components/common/AndroidUpdateBanner', () => ({ AndroidUpdateBanner: () => null }));
vi.mock('../../components/settings/TimezonePrompt', () => ({ TimezonePrompt: () => null }));
vi.mock('../../hooks/usePushSubscriptionSync', () => ({
  usePushSubscriptionSync: () => ({
    config: null,
    capability: 'unsupported',
    requestPermission: vi.fn(),
    isRequestingPermission: false,
  }),
}));
vi.mock('../../hooks/useNotificationClickHandling', () => ({ useNotificationClickHandling: vi.fn() }));
vi.mock('../../hooks/useReviewQueues', () => ({
  useReviewQueues: () => ({ entries: [], counts: null, totalPending: 0, isLoading: false, anyEnabled: true }),
}));
vi.mock('../../components/collections/CollectionsList', () => ({
  CollectionsList: () => <div data-testid="collections-list" />,
}));
vi.mock('../../components/review/ReviewQueueList', () => ({
  ReviewQueueList: () => <div data-testid="review-list" />,
  reviewQueuePath: (key: string) => `/review/${key}`,
}));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, Outlet: () => <div data-testid="outlet" /> };
});

function chromeAt(px: number, route = '/albums') {
  renderShell(<Layout />, { width: px, route });
  return {
    rail: document.querySelector('nav[aria-label="Main navigation"]') !== null,
    bottom: document.querySelector('.MuiBottomNavigation-root') !== null,
    pane: document.querySelector('[data-shell-context-pane]') !== null,
  };
}

describe('breakpoint sweep — one navigation surface at every width (issue #402)', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [360, 'bottom', false],
    [599, 'bottom', false],
    [600, 'rail', false],
    [750, 'rail', false],
    [768, 'rail', false],
    [834, 'rail', false],
    [899, 'rail', false],
    [900, 'rail', false],
    [1199, 'rail', false],
    [1200, 'rail', true],
    [1600, 'rail', true],
  ] as const)('%dpx → %s, context pane: %s', (px, expected, pane) => {
    const chrome = chromeAt(px);
    expect(chrome.rail).toBe(!chrome.bottom);
    expect(chrome.rail).toBe(expected === 'rail');
    expect(chrome.pane).toBe(pane);
  });

  it('draws no context pane for Photos even at 1600px', () => {
    expect(chromeAt(1600, '/').pane).toBe(false);
  });
});
