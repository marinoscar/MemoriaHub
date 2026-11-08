/**
 * useCircleLinkParam (RETRO-D3, #576): a notification link's `?c=<circleId>`
 * switches the active circle (only to a circle the user belongs to) and is
 * stripped from the URL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';

vi.mock('../../hooks/useCircle', () => ({ useCircle: vi.fn() }));

import { useCircle } from '../../hooks/useCircle';
import { useCircleLinkParam } from '../../hooks/useCircleLinkParam';

const setActiveCircle = vi.fn().mockResolvedValue(undefined);

function circles(...ids: string[]) {
  return ids.map((id) => ({ id, name: id }));
}

function setCircles(list: { id: string; name: string }[], activeCircleId: string | null) {
  vi.mocked(useCircle).mockReturnValue({ circles: list, activeCircleId, setActiveCircle } as never);
}

function run(url: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>
  );
  return renderHook(
    () => {
      useCircleLinkParam();
      return useLocation();
    },
    { wrapper },
  );
}

describe('useCircleLinkParam', () => {
  beforeEach(() => vi.clearAllMocks());

  it('switches to a known circle and strips the parameter', async () => {
    setCircles(circles('circle-1', 'circle-2'), 'circle-1');
    const { result } = run('/bursts?c=circle-2&x=1');
    await waitFor(() => expect(result.current.search).toBe('?x=1'));
    expect(setActiveCircle).toHaveBeenCalledWith('circle-2');
    expect(result.current.pathname).toBe('/bursts');
  });

  it('does not switch to a circle the user does not belong to, but strips it', async () => {
    setCircles(circles('circle-1'), 'circle-1');
    const { result } = run('/bursts?c=circle-999');
    await waitFor(() => expect(result.current.search).toBe(''));
    expect(setActiveCircle).not.toHaveBeenCalled();
  });

  it('does not switch when the circle is already active', async () => {
    setCircles(circles('circle-1'), 'circle-1');
    const { result } = run('/?c=circle-1');
    await waitFor(() => expect(result.current.search).toBe(''));
    expect(setActiveCircle).not.toHaveBeenCalled();
  });

  it('waits for the circle list to load', () => {
    setCircles([], null);
    const { result } = run('/?c=circle-1');
    expect(result.current.search).toBe('?c=circle-1');
    expect(setActiveCircle).not.toHaveBeenCalled();
  });
});
