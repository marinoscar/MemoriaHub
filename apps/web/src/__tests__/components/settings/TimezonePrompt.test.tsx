/**
 * `TimezonePrompt` — unit tests (issue #444).
 *
 * Presentational only: it renders whatever `AuthContext` exposes and offers the
 * two outcomes (accept, dismiss). Detection lives in `useTimezoneAutoDetect`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeContextProvider } from '../../../contexts/ThemeContext';
import { AuthContext } from '../../../contexts/AuthContext';
import { TimezonePrompt } from '../../../components/settings/TimezonePrompt';
import type { TimezoneMismatch } from '../../../hooks/useTimezoneAutoDetect';

interface Overrides {
  timezoneMismatch: TimezoneMismatch | null;
  applyDetectedTimezone?: () => Promise<void>;
  dismissTimezoneMismatch?: () => void;
}

function renderPrompt(overrides: Overrides) {
  const value = {
    user: null,
    isLoading: false,
    isAuthenticated: true,
    providers: [],
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    refreshUser: vi.fn().mockResolvedValue(undefined),
    applyDetectedTimezone: vi.fn().mockResolvedValue(undefined),
    dismissTimezoneMismatch: vi.fn(),
    ...overrides,
  };

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter>
        <ThemeContextProvider>
          <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
        </ThemeContextProvider>
      </MemoryRouter>
    );
  }

  return { ...render(<TimezonePrompt />, { wrapper: Wrapper }), value };
}

describe('TimezonePrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing without a mismatch', () => {
    const { container } = renderPrompt({ timezoneMismatch: null });
    expect(container).toBeEmptyDOMElement();
  });

  it('names both zones so the user can tell what would change', () => {
    renderPrompt({
      timezoneMismatch: { stored: 'America/Costa_Rica', detected: 'Europe/Madrid' },
    });

    expect(screen.getByText(/Europe\/Madrid/)).toBeInTheDocument();
    expect(screen.getByText(/America\/Costa_Rica/)).toBeInTheDocument();
  });

  it('applies the detected zone only on an explicit Update', async () => {
    const user = userEvent.setup();
    const applyDetectedTimezone = vi.fn().mockResolvedValue(undefined);

    renderPrompt({
      timezoneMismatch: { stored: 'America/Costa_Rica', detected: 'Europe/Madrid' },
      applyDetectedTimezone,
    });

    expect(applyDetectedTimezone).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /update/i }));
    await waitFor(() => expect(applyDetectedTimezone).toHaveBeenCalledTimes(1));
  });

  it('reports a failed update instead of pretending it worked', async () => {
    const user = userEvent.setup();
    const applyDetectedTimezone = vi.fn().mockRejectedValue(new Error('boom'));

    renderPrompt({
      timezoneMismatch: { stored: 'America/Costa_Rica', detected: 'Europe/Madrid' },
      applyDetectedTimezone,
    });

    await user.click(screen.getByRole('button', { name: /update/i }));

    await waitFor(() =>
      expect(screen.getByText(/couldn't update your time zone/i)).toBeInTheDocument(),
    );
  });

  it('dismisses via "Not now" without writing anything', async () => {
    const user = userEvent.setup();
    const dismissTimezoneMismatch = vi.fn();
    const applyDetectedTimezone = vi.fn().mockResolvedValue(undefined);

    renderPrompt({
      timezoneMismatch: { stored: 'America/Costa_Rica', detected: 'Europe/Madrid' },
      applyDetectedTimezone,
      dismissTimezoneMismatch,
    });

    await user.click(screen.getByRole('button', { name: /not now/i }));
    expect(dismissTimezoneMismatch).toHaveBeenCalledTimes(1);
    expect(applyDetectedTimezone).not.toHaveBeenCalled();
  });
});
