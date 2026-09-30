/**
 * Issue #486 — opening a notification from outside the bell: service-worker
 * toast clicks (`notification-click` messages), page-toast clicks (the store's
 * open handler) and cold opens (`?n=<id>`). Each marks the row read, switches
 * circle first when needed, and navigates.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

const setActiveCircle = vi.fn().mockResolvedValue(undefined);
let circleState = {
  circles: [{ id: 'circle-1' }, { id: 'circle-2' }] as Array<{ id: string }>,
  activeCircleId: 'circle-1' as string | null,
};
vi.mock('../../hooks/useCircle', () => ({
  useCircle: () => ({ ...circleState, setActiveCircle }),
}));

const markReadMock = vi.fn().mockResolvedValue(undefined);
let registeredHandler: ((n: { circleId: string | null; link: string | null }) => void) | null = null;
vi.mock('../../hooks/useNotifications', () => ({
  markNotificationReadById: (id: string) => markReadMock(id),
  setNotificationOpenHandler: (h: typeof registeredHandler) => {
    registeredHandler = h;
    return () => {
      if (registeredHandler === h) registeredHandler = null;
    };
  },
}));

import {
  useNotificationClickHandling,
  useOpenNotificationTarget,
} from '../../hooks/useNotificationClickHandling';

function wrapper(route = '/') {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
  );
}

function swListener(): (e: MessageEvent) => void {
  const add = navigator.serviceWorker.addEventListener as unknown as ReturnType<typeof vi.fn>;
  const call = add.mock.calls.find((c: unknown[]) => c[0] === 'message');
  return call![1] as (e: MessageEvent) => void;
}

beforeEach(() => {
  vi.clearAllMocks();
  registeredHandler = null;
  circleState = { circles: [{ id: 'circle-1' }, { id: 'circle-2' }], activeCircleId: 'circle-1' };
});

describe('useOpenNotificationTarget', () => {
  it('switches circle BEFORE navigating when the target is another known circle', () => {
    const { result } = renderHook(() => useOpenNotificationTarget(), { wrapper: wrapper() });
    act(() => result.current({ circleId: 'circle-2', link: '/bursts' }));
    expect(setActiveCircle).toHaveBeenCalledWith('circle-2');
    expect(navigateMock).toHaveBeenCalledWith('/bursts');
    expect(setActiveCircle.mock.invocationCallOrder[0]).toBeLessThan(
      navigateMock.mock.invocationCallOrder[0],
    );
  });

  it('does not switch for the active circle, a global row, or an unknown circle', () => {
    const { result } = renderHook(() => useOpenNotificationTarget(), { wrapper: wrapper() });
    act(() => result.current({ circleId: 'circle-1', link: '/a' }));
    act(() => result.current({ circleId: null, link: '/b' }));
    act(() => result.current({ circleId: 'gone', link: '/c' }));
    expect(setActiveCircle).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledTimes(3);
  });

  it('refuses to navigate to anything but a root-relative link', () => {
    const { result } = renderHook(() => useOpenNotificationTarget(), { wrapper: wrapper() });
    act(() => result.current({ circleId: null, link: 'https://evil.example' }));
    act(() => result.current({ circleId: null, link: '//evil.example' }));
    act(() => result.current({ circleId: null, link: null }));
    expect(navigateMock).not.toHaveBeenCalled();
  });
});

describe('useNotificationClickHandling', () => {
  it('handles a service-worker notification-click: mark read, switch circle, navigate', () => {
    renderHook(() => useNotificationClickHandling(), { wrapper: wrapper() });
    act(() => {
      swListener()(
        new MessageEvent('message', {
          data: { type: 'notification-click', id: 'n1', link: '/duplicates', circleId: 'circle-2' },
        }),
      );
    });
    expect(markReadMock).toHaveBeenCalledWith('n1');
    expect(setActiveCircle).toHaveBeenCalledWith('circle-2');
    expect(navigateMock).toHaveBeenCalledWith('/duplicates');
  });

  it('does not mark anything read for a test push click (empty id)', () => {
    renderHook(() => useNotificationClickHandling(), { wrapper: wrapper() });
    act(() => {
      swListener()(
        new MessageEvent('message', { data: { type: 'notification-click', id: '', link: '/' } }),
      );
    });
    expect(markReadMock).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith('/');
  });

  it('ignores unrelated worker messages', () => {
    renderHook(() => useNotificationClickHandling(), { wrapper: wrapper() });
    act(() => {
      swListener()(new MessageEvent('message', { data: { type: 'push-subscription-change' } }));
    });
    expect(markReadMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('registers the page-toast open handler and unregisters on unmount', () => {
    const { unmount } = renderHook(() => useNotificationClickHandling(), { wrapper: wrapper() });
    expect(registeredHandler).not.toBeNull();
    act(() => registeredHandler!({ circleId: 'circle-2', link: '/enhancements' }));
    expect(setActiveCircle).toHaveBeenCalledWith('circle-2');
    expect(navigateMock).toHaveBeenCalledWith('/enhancements');
    unmount();
    expect(registeredHandler).toBeNull();
  });

  it('marks a cold-opened ?n=<id> read and strips the param', () => {
    let search = '';
    renderHook(
      () => {
        useNotificationClickHandling();
        search = useLocation().search;
      },
      { wrapper: wrapper('/bursts?n=abc&keep=1') },
    );
    expect(markReadMock).toHaveBeenCalledWith('abc');
    expect(search).toBe('?keep=1');
  });

  it('does nothing without ?n=', () => {
    renderHook(() => useNotificationClickHandling(), { wrapper: wrapper('/bursts') });
    expect(markReadMock).not.toHaveBeenCalled();
  });
});
